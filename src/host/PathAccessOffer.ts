import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { FolderPermission, ResolvedPathGrant } from '../types';
import { accessPhysicalPath, type PathAccessChoice, type PathAccessRequest, type SessionLocalReadScopeConsent, type SessionPathAccessGrant } from '../backend/localReadScope';
import { fileToolReachesAnotherComputer } from './namedOutsidePaths';
import { matchPathAccess } from '../backend/localReadScope';
import { AccessTable, type AccessConsumer, type NeedRow, type NeedWhy } from './AccessTable';

export interface PathAccessOfferPorts {
  owner: SessionLocalReadScopeConsent;
  /** v0.9.101 (the access table): the agent this offer speaks for; the consumer of a need it records, unless told another. */
  agentId?: string;
  canOffer(): boolean;
  captureRequest(): PathAccessRequest | undefined;
  /**
   * `named`: the person's own message names the path, and nothing has tried it yet (v0.9.100). `notice` names the
   * target and says whether a Read already held needs Read + Write (v0.9.101).
   */
  present(named: string, cause: PathAccessOfferCause, notice: PathAccessNotice): PromiseLike<boolean>;
  choose(target: Readonly<ResolvedPathGrant>, forRequest: boolean): Promise<PathAccessChoice | undefined>;
  /**
   * `continueOffered`: the request's item now offers Continue for this grant (v0.9.101, §4.2). With a shared item list
   * (v0.9.101, H2a), each participant of the item is told through its own port.
   */
  granted(grant: SessionPathAccessGrant, requestStillCurrent: boolean, requestId: string | undefined, continueOffered: boolean): void;
  /**
   * v0.9.101 (§4.2): a grant was made once its request had ended. How one explicit click continues that request, when no
   * record of the request's own continues it; undefined offers no Continue. Asked once per such grant. It starts nothing.
   */
  continuation?(requestId: string): RequestContinuation | undefined;
  unavailable(): void;
  /** The person chose For this request after that request ended: nothing was granted, and why is not one of unavailable's reasons. */
  requestEnded(): void;
  /** v0.9.101 (F2): the request's own item for this target, shown again whenever its state changes. */
  item?(item: PathAccessItem): void;
  /** v0.9.101 (F2): Grant access was chosen for a target its grants already reach, typically on an older notice. */
  satisfied?(label: string, permission: FolderPermission): void;
  /** Whether a target is a folder, where the host can tell without contacting another computer. */
  isDirectory?(target: string): boolean | undefined;
  /**
   * v0.9.101 (G3): a file call of this agent was refused for a target nothing closes yet, in `request`. `access` closes
   * it, as this offer judges: Read + Write once a Read grant was refused again, Read otherwise.
   */
  refused?(named: string, request: PathAccessRequest, access: FolderPermission): void;
}

/** Why a path is offered: a file tool could not reach it, or the person's message names it as the request starts. */
export type PathAccessOfferCause = 'refused' | 'named';

/** What a notice for one target says: its kind and name first, the full path after them. */
export interface PathAccessNotice {
  /** `File report.docx`, `Folder output`; with its folder's name when another target of the request has its name. */
  label: string;
  /** A Read grant holds the target, and the work was refused again: it needs Read + Write. */
  upgrade: boolean;
}

/** What a target's item in the request shows now, and its Grant access, which runs the same handler as the notice's. */
export interface PathAccessItem {
  /** Host-issued: one per target and request. */
  id: string;
  requestId?: string;
  label: string;
  /** The path as it was named. */
  target: string;
  state: 'needs-access' | 'needs-write' | 'choosing' | 'granted' | 'reachable' | 'readable' | 'limit' | 'merged';
  /** What the person's grants give it now, if anything. */
  held?: FolderPermission;
  /**
   * `reachable` (smoke of c2ec1f79): what it needs is met by access the agent already has, not by a grant (its
   * configured reach, such as the workspace's parent folder, readable by default, or Full access). Nothing is called
   * granted that the person did not grant.
   */
  reach?: FolderPermission;
  /**
   * `merged` (audit of cc0b6bc6, F3): the label of the folder item its access is asked on now. This item has no Grant
   * access of its own then: the request has one entry for the folder.
   */
  shownWith?: string;
  /**
   * The item's Grant access. v0.9.103 (the Owner's field test of c51e3bb3): settles once the person's choice is over,
   * with true when the access picker was shown, so the chat the click came from can take focus back from it.
   */
  grant(): void | Promise<boolean>;
  /**
   * v0.9.101 (§4.2): after a grant made once the request had ended. `offered`: Continue sends the original request again,
   * once, when chosen. `started`: it was chosen. `unavailable`: it was chosen and the request could not be continued.
   */
  continuation?: 'offered' | 'started' | 'unavailable';
  /** Present only while `continuation` is `offered`. */
  continueRequest?(): void;
}

/**
 * v0.9.101 (§4.2): one explicit continuation of an ended request, from the host's own record of it: the person's request
 * sent again, once it has ended. v0.9.101 (H2a): it is the only Continue. Work of a request that waits for access keeps
 * the request owned, and a grant wakes it there, so no Continue is needed for it.
 */
export interface RequestContinuation {
  /** Whether it may still start: nothing of the request's own has begun to continue it meanwhile. */
  available(): boolean;
  /** Starts the request again. Resolves to whether it was started. */
  start(): Promise<boolean>;
}

/** The words of a notice: kind and name first, so two notices are told apart where a narrow pane cuts them off. */
export function pathAccessNoticeText(agent: string, named: string, cause: PathAccessOfferCause, notice: PathAccessNotice): string {
  if (notice.upgrade) {
    return `${notice.label} — ${agent} has Read access; saving there needs Read + Write. Full path: ${named}`;
  }
  return cause === 'named'
    // v0.9.100 (field, 4523a765): offered as the request starts, before any work, for a path the request names.
    ? `${notice.label} — your request names it, outside this workspace, and ${agent} cannot reach it yet. Grant access now so the work can use it. Full path: ${named}`
    : `${notice.label} — ${agent} could not reach it with the file tools. Current work continues without it. Full path: ${named}`;
}

/** One line for a target's item: what it is, and what it needs or holds now. */
export function pathAccessItemTitle(item: Pick<PathAccessItem, 'label' | 'state' | 'held' | 'shownWith' | 'reach'>): string {
  switch (item.state) {
    case 'merged': return `${item.label} — asked for on the item for ${item.shownWith ?? 'its folder'}`;
    case 'granted': return `${item.label} — ${item.held === 'readwrite' ? 'Read + Write' : 'Read'} access granted`;
    case 'reachable': return `${item.label} — ${item.reach === 'readwrite' ? 'Read + Write' : 'Read'} access already available; nothing was granted`;
    case 'readable': return `${item.label} — can be read now; writing to it needs Read + Write`;
    case 'needs-write': return `${item.label} — has Read; saving needs Read + Write access`;
    case 'choosing': return `${item.label} — choosing access`;
    case 'limit': return `${item.label} — outside a limit a grant cannot change`;
    default: return `${item.label} — not granted yet`;
  }
}

/** The item as the chat shows it: its line, the full path and what Grant access does now, and whether it is offered. */
export function pathAccessItemView(item: PathAccessItem): PathAccessItemView {
  const revoke = 'To revoke it, open UnodeAi: Security from the Command Palette and use revoke under File access grants.';
  const detail = item.state === 'granted'
    ? [CONTINUE_DETAIL[item.continuation ?? 'none'], revoke].filter(Boolean).join(' ')
    : item.state === 'reachable' ? 'The agent can already use it with the access it has: its configured folders (by default the workspace\'s parent folder is readable) or Full access. No grant was made, and none is needed now.'
    // v0.9.102 (field T2): your request names it, and the agent can read it but not write to it. Saying no grant was
    // needed delayed the Read + Write a save there needed until the task asked for it again.
    : item.state === 'readable' ? 'The agent can already read it with the access it has: its configured folders (by default the workspace\'s parent folder is readable). Nothing was granted. If the work saves files there, grant Read + Write now; work that only reads it continues.'
    : item.state === 'choosing' ? 'The access picker for it is open.'
      : item.state === 'needs-write' ? 'Grant access to choose Read + Write. Work that does not need it continues.'
        : item.state === 'limit' ? 'The agent that needs it has its own Folder Access, which a grant does not widen. Change that agent\'s Folder Access to let it use this path.'
        : item.state === 'merged' ? `It lies in ${item.shownWith ?? 'a folder'}, which this request also needs: grant access on that item.`
        : 'Grant access to choose Read or Read + Write. Work that does not need it continues.';
  const continueRequest = item.state === 'granted' && item.continuation === 'offered' ? item.continueRequest : undefined;
  return { id: item.id, title: pathAccessItemTitle(item), detail: `Full path: ${item.target}\n\n${detail}`,
    actionable: item.state === 'needs-access' || item.state === 'needs-write' || item.state === 'readable', grant: item.grant,
    ...(continueRequest ? { continueRequest } : {}) };
}

/** What the chat shows for a target's item; `continueRequest` is present only while Continue is offered. */
export interface PathAccessItemView {
  id: string;
  title: string;
  detail: string;
  actionable: boolean;
  /**
   * The item's Grant access. v0.9.103 (the Owner's field test of c51e3bb3): settles once the person's choice is over,
   * with true when the access picker was shown, so the chat the click came from can take focus back from it.
   */
  grant(): void | Promise<boolean>;
  continueRequest?(): void;
}

const CONTINUE_DETAIL: Record<NonNullable<PathAccessItem['continuation']> | 'none', string> = {
  none: '',
  offered: 'Your request had already ended. Continue sends it again, as a new request, so the work can use this access; nothing starts until you choose it.',
  started: 'Your request was sent again, as a new request.',
  unavailable: 'Your request was not sent again: it was stopped or is no longer available here. To go on, send it again.',
};

/** One target of one request: its item, whoever offered it. */
export interface PathAccessTargetState {
  /** Its card's id. A folder item that arrives later takes over the card of an item now shown on it (F3). */
  id: string;
  readonly key: string;
  /** v0.9.101 (the access table): the table row this item shows, with every row shown on it. */
  readonly rowId: string;
  /** Its card was taken over by the folder item it is shown on: it draws nothing until it has an item of its own again. */
  handedOver?: boolean;
  /** Its card has been drawn in a chat. */
  drawn?: boolean;
  readonly named: string;
  readonly request: PathAccessRequest;
  kind: 'File' | 'Folder';
  label: string;
  /** A notice for it is shown and not answered. */
  noticeOpen: boolean;
  /** Its access picker is open. */
  choosing: boolean;
  /** The causes a notice was shown for while nothing held it, each once. */
  readonly shownFor: Set<PathAccessOfferCause>;
  /** The one Read → Read + Write notice. A gap that has not changed is not shown again. */
  upgradeShown: boolean;
  /** v0.9.101 (§4.2): the Continue of the latest grant made after the request ended, until it is chosen. */
  continuation?: RequestContinuation;
  /** What became of a Continue that was chosen. */
  continued?: 'started' | 'unavailable';
  /**
   * v0.9.101 (H2a): the agents of the request whose own refusal or need, or the request's naming, put it here, by their
   * offer's ports. Each sees the item, and a grant on it tells each of them; nobody else is told.
   */
  readonly participants: Set<PathAccessOfferPorts>;
}

/**
 * v0.9.101 (H2a, H3): the items of every request, shared by the offers of every agent. One item per request and target:
 * the request naming it, a worker's refused file call and the PM's dispatch all update it, and one grant on it reaches
 * every participant. Requests keep their own items. Without one, an offer keeps its own items, as before.
 */
export class PathAccessRequestItems {
  readonly targets = new Map<string, PathAccessTargetState>();
  /**
   * The requests a Continue was chosen for. Continue goes on with a request once, whichever of its paths offered it:
   * two paths granted after the request ended each offered one, and each sent the request again (security re-audit, F2).
   */
  readonly continuedRequests = new Set<string>();
  /**
   * v0.9.101 (the access table): the rows every item is drawn from. The host passes the project's table; without one,
   * the first offer makes one judged by its owner's grants alone.
   */
  table?: AccessTable;
  /** Redraws the items of the rows a table transaction changed; set once, by the first offer. */
  redrawing = false;
  /** `granted`: a grant was made on an item of `requestId`, before its participants are told. */
  constructor(readonly hooks: { granted?(grant: SessionPathAccessGrant, requestId: string | undefined): void } = {}, table?: AccessTable) {
    this.table = table;
  }
}

/** A table judged by the deliberate grants of one owner alone: for an offer the host gave no table. */
function grantsTable(owner: SessionLocalReadScopeConsent): AccessTable {
  return new AccessTable({
    judge: (_consumer, requestId, named, needed) => {
      const grants = owner.pathAccessFor(requestId);
      const write = matchPathAccess(grants, named, 'readwrite');
      const read = write ?? matchPathAccess(grants, named, 'read');
      const granted = write ? 'readwrite' as const : read ? 'read' as const : 'none' as const;
      const state = granted === 'readwrite' || (granted === 'read' && needed === 'read') ? 'met' as const
        : granted === 'read' ? 'partial' as const : 'missing' as const;
      return { state, effective: granted, source: granted === 'none' ? 'none' as const : 'grant' as const, granted,
        grantIds: [...new Set([write, read].flatMap((match) => match ? [match.grant.id] : []))] };
    },
    identity: (named) => {
      if (fileToolReachesAnotherComputer(path.resolve(named))) return undefined;
      try { return accessPhysicalPath(named); } catch { return undefined; }
    },
    remote: (named) => fileToolReachesAnotherComputer(path.resolve(named)),
  });
}

/** What an item shows, read from its rows: every need row of the row it shows and of the rows shown on it. */
interface ItemFacts {
  status: 'granted' | 'reachable' | 'readable' | 'needs-write' | 'needs-access' | 'limit';
  /** What the person's own grants give the item's own target. */
  held?: FolderPermission;
  /** `reachable`: what the agent reaches without a grant. */
  reach?: FolderPermission;
  /** The strongest access a row not yet met needs. */
  needed: FolderPermission;
}

function itemFacts(table: AccessTable, rowId: string): ItemFacts {
  const rows = table.shownRows(rowId);
  const needs: NeedRow[] = rows.flatMap((row) => [...table.needsOf(row.id)] as NeedRow[]);
  const own = [...table.needsOf(rowId)];
  const rank = (permission: 'none' | FolderPermission) => (permission === 'readwrite' ? 2 : permission === 'read' ? 1 : 0);
  const best = (own.length ? own : needs).reduce<'none' | FolderPermission>((held, need) =>
    (rank(need.judgement.granted) > rank(held) ? need.judgement.granted : held), 'none');
  const held = best === 'none' ? undefined : best;
  const open = needs.filter((need) => need.judgement.state !== 'limit');
  const unmet = open.filter((need) => need.judgement.state !== 'met');
  const needed: FolderPermission = unmet.some((need) => need.needed === 'readwrite') ? 'readwrite' : 'read';
  if (!open.length) return { status: needs.length ? 'limit' : 'needs-access', ...(held ? { held } : {}), needed };
  if (!unmet.length) {
    if (held) return { status: 'granted', held, needed };
    // Met, and no grant gives any of it: access the agent already has, never called granted (smoke of c2ec1f79).
    const reach = open.some((need) => need.judgement.effective === 'readwrite') ? 'readwrite' as const : 'read' as const;
    // v0.9.102 (field T2): a path the person's request names may be where the work saves, which the request alone
    // cannot tell. Read alone met is said as such, with Grant access for Read + Write; it holds up nothing.
    if (reach === 'read' && open.some((need) => need.why.has('named'))) return { status: 'readable', reach, needed };
    return { status: 'reachable', reach, needed };
  }
  return { status: held === 'read' || unmet.some((need) => need.judgement.state === 'partial') ? 'needs-write' : 'needs-access',
    ...(held ? { held } : {}), needed };
}


/** Items of requests that have ended are kept this many targets at most. */
const RETAINED_TARGETS = 512;

/**
 * A recoverable local notice, not a tool replay or a new approval service. The scope owner admits the choice.
 *
 * v0.9.101 (F2, field aebbd520): each target of a request has one state, whatever offers it: the request naming it, a
 * refused file tool, or a task contract's refused input. The notice's Grant access and the item's call one handler,
 * which looks at the grants again when it runs. A second cause for a target whose notice or picker is still open, or
 * that a grant already reaches, shows no other notice: before, the start's notice and a refusal's both showed, and once
 * one was granted the other still looked unanswered. A Read grant followed by a refusal shows one Read + Write notice.
 * VS Code cannot withdraw a notice once shown; an older one's Grant access finds the grant and says so.
 */
export function createPathAccessOffer(ports: PathAccessOfferPorts, shared?: PathAccessRequestItems): (named: string, cause?: PathAccessOfferCause, access?: FolderPermission, consumer?: AccessConsumer) => void {
  const items = shared ?? new PathAccessRequestItems();
  const targets = items.targets;
  const continuedRequests = items.continuedRequests;
  /**
   * The ports a choice on this item runs with: the chooser and its answers are the clicking agent's own; Continue is the
   * request's, whichever participant's record continues it (F1 keeps it to the agent the request addressed); and the
   * grant is told to every participant.
   */
  const portsFor = (state: PathAccessTargetState, via: PathAccessOfferPorts): PathAccessOfferPorts => {
    const participants = [...state.participants];
    return { ...via,
      continuation: (requestId) => {
        for (const participant of participants) {
          const continuation = participant.continuation?.(requestId);
          if (continuation) return continuation;
        }
        return undefined;
      },
      granted: (grant, current, requestId, continueOffered) => {
        try { items.hooks.granted?.(grant, requestId); } catch { /* Readiness is judged again at the next grant. */ }
        for (const participant of participants) {
          try { participant.granted(grant, current, requestId, continueOffered); } catch { /* One participant's notice does not stop another's. */ }
        }
      },
    };
  };
  const withdrawContinues = (requestId: string | undefined) => {
    for (const other of targets.values()) {
      if (other.request.requestId !== requestId || !other.continuation) continue;
      other.continuation = undefined;
      show(other);
    }
  };

  // v0.9.101 (the access table): every item is drawn from the table's rows; nothing here keeps access state of its own.
  const table = items.table ?? (items.table = grantsTable(ports.owner));
  // An item whose row was hung on a folder that arrived later shows that folder's rows, so it never goes stale (R2 §5).
  const facts = (state: PathAccessTargetState) => itemFacts(table, table.target(state.rowId)?.shownOn ?? state.rowId);
  const closed = (state: PathAccessTargetState) => {
    const status = facts(state).status;
    return status === 'granted' || status === 'reachable' || status === 'limit';
  };

  const decisionOf = (request: PathAccessRequest) => (request.decisionCurrent ?? request.isCurrent)();
  const runningOf = (request: PathAccessRequest) => (request.requestCurrent ?? request.isCurrent)();

  /** The item of the request that shows `rowId` itself, if there is one. */
  const stateOf = (requestId: string | undefined, rowId: string) => targets.get(`${requestId ?? ''}\u0000${rowId}`);

  /** Every participant sees the one item, in its own chat; its Grant access runs the one handler, with its own chooser. */
  const show = (state: PathAccessTargetState) => {
    // Audit of cc0b6bc6, F3: a row hung on a folder that has its own item is that item's. Its card was taken over by
    // the folder's, or says where its access is asked for now, with no Grant access of its own: one entry per folder.
    const hostId = table.target(state.rowId)?.shownOn ?? state.rowId;
    const host = hostId !== state.rowId ? stateOf(state.request.requestId, hostId) : undefined;
    if (host) {
      if (state.handedOver) return;
      for (const participant of state.participants) {
        if (!participant.item) continue;
        state.drawn = true;
        try {
          participant.item({ id: state.id, requestId: state.request.requestId, label: state.label, target: state.named, state: 'merged',
            shownWith: host.label, grant: () => undefined });
        } catch { /* The item is a view of this state. */ }
      }
      return;
    }
    // It leads outside its folder again, or the folder item is gone: it has an item of its own, a new card.
    state.handedOver = undefined;
    const now = facts(state);
    const permission = now.held;
    const row = table.target(state.rowId);
    if (row && row.label !== state.label) state.label = row.label;
    // A Stop, a cleared chat or a removed agent since the grant withdraws its Continue.
    const offered = !!state.continuation && decisionOf(state.request);
    const continuation = offered ? 'offered' as const : state.continued;
    for (const participant of state.participants) {
      if (!participant.item) continue;
      state.drawn = true;
      try {
        participant.item({ id: state.id, requestId: state.request.requestId, label: state.label, target: state.named,
          state: state.choosing ? 'choosing' : now.status,
          ...(permission ? { held: permission } : {}), ...(now.reach ? { reach: now.reach } : {}),
          grant: () => {
            let asked = false;
            return handle(state, participant, () => { asked = true; })
              .then(() => asked, () => { participant.unavailable(); return asked; });
          },
          ...(continuation ? { continuation } : {}),
          ...(offered ? { continueRequest: () => { void proceed(state); } } : {}) });
      } catch { /* The item is a view of this state; the notice and the grants do not depend on it. */ }
    }
  };

  /**
   * v0.9.101 (§4.2): the person chose Continue. Once per grant: the Continue is spent before anything is asked, so a
   * second click, or one from the other chat surface, starts nothing.
   */
  const proceed = async (state: PathAccessTargetState): Promise<void> => {
    const continuation = state.continuation;
    if (!continuation) return;
    state.continuation = undefined;
    const requestId = state.request.requestId;
    const first = !!requestId && !continuedRequests.has(requestId);
    if (requestId) { continuedRequests.add(requestId); withdrawContinues(requestId); }
    let started = false;
    if (first && decisionOf(state.request) && !runningOf(state.request) && continuation.available()) {
      state.continued = 'started';
      show(state);
      try { started = await continuation.start(); } catch { started = false; }
    }
    if (!started) state.continued = 'unavailable';
    if (requestId) table.setContinuation(requestId, started ? 'spent:started' : 'spent:unavailable');
    show(state);
  };

  /** The one handler for a target: its notice's Grant access and its item's, in any participant's chat. */
  const handle = async (state: PathAccessTargetState, via: PathAccessOfferPorts = ports, onAsked?: () => void): Promise<void> => {
    const ports = portsFor(state, via);
    // The picker is open already. A second click asks nothing more.
    if (state.choosing) return;
    // The person chose Grant access on the item: its rows are judged again first (R2 §3).
    if (state.request.requestId) table.rejudge(state.request.requestId, state.rowId);
    if (closed(state)) {
      show(state);
      const held = facts(state).held;
      if (held) ports.satisfied?.(state.label, held);
      else show(state);
      return;
    }
    const request = state.request;
    // v0.9.101 (the access table, R2 §2): a request the table records as closed takes no grant, whatever else says.
    const closedRow = () => !!request.requestId && table.request(request.requestId)?.lifecycle === 'closed';
    const decisionCurrent = () => !closedRow() && (request.decisionCurrent ?? request.isCurrent)() && ports.canOffer();
    // A logical request can go on through later turns. Once it has ended, only a session grant can still be used.
    const requestRunning = () => (request.requestCurrent ?? request.isCurrent)();
    if (!decisionCurrent()) { ports.unavailable(); return; }
    let dismissed = false;
    state.choosing = true;
    show(state);
    let grant: SessionPathAccessGrant | undefined;
    try {
      grant = await ports.owner.requestPathAccess(state.named,
        { ...request, isCurrent: decisionCurrent },
        async (target) => {
          onAsked?.();
          const choice = await ports.choose(target, !!request.requestId && requestRunning());
          dismissed = choice === undefined;
          return choice;
        });
    } finally {
      state.choosing = false;
    }
    if (!grant) { show(state); if (!dismissed) ports.unavailable(); return; }
    if (grant.lifetime === 'request' && !requestRunning()) {
      ports.owner.revokePathAccess(grant.id);
      show(state);
      ports.requestEnded();
      return;
    }
    // The grant is a row of the table: its rows are judged again before anyone is told.
    table.inputsChanged();
    // v0.9.101 (§4.2): granted once the request had ended. Where nothing of the request's own continues it, the item
    // offers Continue for this grant; nothing starts until it is chosen. A grant made while the request runs reaches it.
    state.continued = undefined;
    state.continuation = undefined;
    if (request.requestId && !requestRunning() && !continuedRequests.has(request.requestId)) {
      try { state.continuation = ports.continuation?.(request.requestId); } catch { state.continuation = undefined; }
      if (state.continuation) table.setContinuation(request.requestId, 'eligible');
    }
    show(state);
    // The authority is committed. A notice/steering delivery failure cannot truthfully report "not changed".
    try { ports.granted(grant, requestRunning(), request.requestId, !!state.continuation); } catch { /* visible in the existing Security grant list */ }
  };

  const notify = (state: PathAccessTargetState, cause: PathAccessOfferCause, upgrade: boolean) => {
    state.noticeOpen = true;
    void (async () => {
      let chosen: boolean;
      try {
        chosen = await ports.present(state.named, cause, { label: state.label, upgrade });
      } finally {
        state.noticeOpen = false;
      }
      if (chosen) await handle(state);
    })().catch(() => ports.unavailable());
  };

  // One redraw for every item of every row a table transaction changed (R1 §2.3).
  if (!items.redrawing) {
    items.redrawing = true;
    table.onChange((change) => {
      for (const state of targets.values()) {
        const host = table.target(state.rowId)?.shownOn ?? state.rowId;
        if (change.targets.has(state.rowId) || change.targets.has(host)
          || (state.request.requestId && change.requests.has(state.request.requestId))) show(state);
      }
    });
  }

  return (named, cause = 'refused', access, consumer) => {
    if (!ports.canOffer()) return;
    const request = ports.captureRequest();
    if (!request || !request.isCurrent()) return;
    const requestId = request.requestId ?? '';
    if (table.request(requestId)?.lifecycle === 'closed') return;
    // A refusal while a Read grant holds the target needs Read + Write (audit of aaf794a2); otherwise what the caller
    // says the work needs, Read when it says nothing.
    const before = table.findTarget(requestId, named);
    const heldBefore = before ? facts({ rowId: before.shownOn } as PathAccessTargetState).held : undefined;
    const needed: FolderPermission = access ?? (cause === 'refused' && heldBefore === 'read' ? 'readwrite' : 'read');
    const why: NeedWhy = cause === 'named' ? 'named' : consumer?.handle && needed === 'readwrite' ? 'output' : consumer?.handle ? 'input' : 'refused';
    const who: AccessConsumer = consumer ?? { agentId: ports.agentId ?? 'agent' };
    table.addNeed(requestId, named, who, needed, why);
    const row = table.findTarget(requestId, named)!;
    // v0.9.101 (H2a, H3; the access table): one item per request and row shown, the folder the person already has an
    // item for when the target lies in it (R2 §5). A new request has its own.
    const shown = table.target(row.shownOn) ?? row;
    const key = `${requestId}\u0000${shown.id}`;
    let state = targets.get(key);
    if (!state) {
      state = { id: `path-access-${randomUUID()}`, key: shown.key, rowId: shown.id, named: shown.named, request, kind: shown.kind,
        label: shown.label, noticeOpen: false, choosing: false, shownFor: new Set(), upgradeShown: false, participants: new Set([ports]) };
      targets.set(key, state);
      // Audit of cc0b6bc6, F3: an item drawn for a row now shown on this one hands its card over, so the chat keeps one
      // card, now the folder's, updated in place. Its notice, if one is still open, still grants what it named.
      const merged = [...targets.values()].find((other) => other !== state && other.request.requestId === request.requestId
        && other.drawn && !other.handedOver && other.rowId !== shown.id && table.target(other.rowId)?.shownOn === shown.id);
      if (merged) {
        state.id = merged.id;
        merged.id = `path-access-${randomUUID()}`;
        merged.handedOver = true;
        merged.drawn = false;
        for (const participant of merged.participants) state.participants.add(participant);
      }
      // Re-review of d9da1b74 (F3): every other item now shown on this one is drawn again at once, as the guide to
      // this item, with no Grant access of its own. The table's change came before this item existed.
      const created = state;
      for (const other of targets.values()) {
        if (other === created || other.request.requestId !== request.requestId || other.rowId === shown.id) continue;
        if (table.target(other.rowId)?.shownOn === shown.id) show(other);
      }
      for (const [stale, other] of targets) {
        if (targets.size <= RETAINED_TARGETS) break;
        if (other.request.requestId !== request.requestId) targets.delete(stale);
      }
    }
    state.participants.add(ports);
    const now = facts(state);
    if (cause === 'refused' && !closed(state)) {
      try { ports.refused?.(path.resolve(named), request, needed); } catch { /* The offer does not depend on it. */ }
    }
    show(state);
    // Already reached, or its notice or picker is still open: this cause updates the item and shows nothing more.
    // A named path the agent can read already is offered on its item only: nothing it needs now is missing.
    if (closed(state) || now.status === 'readable' || state.noticeOpen || state.choosing) return;
    // v0.9.102 (field T2, the Owner's "fix now"): Read reached and Read + Write needed is the same need whether the Read
    // came from a grant or from the agent's own folders (the default parent read scope). The notice says the agent can
    // read it and that saving there needs Read + Write; "could not reach it" was untrue for a folder it can read.
    if (now.held === 'read' || now.status === 'needs-write') {
      if (state.upgradeShown) return;
      state.upgradeShown = true;
      notify(state, cause, true);
      return;
    }
    // Nothing holds it: each cause once, so a dismissed start notice still leaves a refusal its own.
    if (state.shownFor.has(cause)) return;
    state.shownFor.add(cause);
    notify(state, cause, false);
  };
}
