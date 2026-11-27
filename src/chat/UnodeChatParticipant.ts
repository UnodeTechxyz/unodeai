/*---------------------------------------------------------------------------------------------
 *  UnodeAi - @unode Chat-panel participant
 *  Puts UnodeAi into VS Code's native Chat panel as `@unode`, ADDITIVELY — the Team / Chat /
 *  Messages sidebar views are untouched and run simultaneously. A user types `@unode <goal>` in the
 *  Chat panel; we hand the goal to the crew's PM (or first agent) on UnodeAi's OWN backend (NOT the
 *  chat-provided model, so the cost-arbitrage/multi-agent value is preserved), stream the run back into
 *  the panel, and offer an "Open in UnodeAi" jump to the full team view.
 *
 *  Toggle with `unode.chatParticipant.enabled` (default on). The handler logic is split from the vscode
 *  registration so it's unit-testable with a fake stream + fake runner.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export interface UnodeChatParticipantDeps {
  /**
   * Run a goal on the crew. Stream text back via `onText`; resolve when the turn completes. Routes to
   * UnodeAi's own backend (not the chat model). `error` is set for a user-actionable problem (e.g. no
   * team yet); a thrown error is treated as unexpected.
   */
  runGoal: (
    prompt: string,
    onText: (markdown: string) => void,
    token: vscode.CancellationToken
  ) => Promise<{ ok: boolean; agentName?: string; error?: string }>;
}

/** The chat request handler — exported separately so it can be unit-tested without `vscode.chat`. */
export function makeUnodeChatHandler(deps: UnodeChatParticipantDeps): vscode.ChatRequestHandler {
  return async (request, _context, stream, token) => {
    const goal = (request.prompt ?? '').trim();
    if (!goal) {
      stream.markdown('Give me a goal and I\'ll put the crew on it — e.g. `@unode add a password-reset flow with tests`.');
      return {};
    }
    stream.progress('UnodeAi is on it…');

    let streamed = false;
    let result: { ok: boolean; agentName?: string; error?: string };
    try {
      result = await deps.runGoal(goal, (md) => { if (md) { streamed = true; stream.markdown(md); } }, token);
    } catch (err) {
      stream.markdown(`\n\n⚠ UnodeAi hit an error: ${err instanceof Error ? err.message : String(err)}`);
      return {};
    }

    if (result.error) {
      stream.markdown(`\n\n⚠ ${result.error}`);
    } else if (!streamed) {
      stream.markdown('_The crew finished without text output — open UnodeAi to see the full run._');
    }
    // The crew's parallel/visual richness (per-agent transcripts, worktree lanes) lives in the full
    // view; the chat is the front door.
    stream.button({ command: 'unode.showTeamPanel', title: 'Open in UnodeAi' });
    return {};
  };
}

/** Register `@unode` in the Chat panel. The `id` must match `contributes.chatParticipants[].id`. */
export function registerUnodeChatParticipant(
  extensionUri: vscode.Uri,
  deps: UnodeChatParticipantDeps
): vscode.ChatParticipant {
  const participant = vscode.chat.createChatParticipant('unode.crew', makeUnodeChatHandler(deps));
  try {
    participant.iconPath = vscode.Uri.joinPath(extensionUri, 'images', 'icon.png');
  } catch {
    /* icon is cosmetic */
  }
  return participant;
}
