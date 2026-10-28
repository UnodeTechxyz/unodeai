#!/usr/bin/env node
'use strict';

// This program is intentionally tiny and dependency-free: Claude launches one copy before every
// native tool call (also inside native subagents). Claude treats exit code 1 as fail-open, so every
// transport/liveness failure here exits *2*. A normal policy denial is represented by hookSpecificOutput
// and exits 0.
const http = require('node:http');

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_DECISION_TIMEOUT_MS = 3 * 60 * 1000;
// MUST stay above WebAccessPolicy's WEB_ACCESS_HUMAN_WINDOW_MS. boundedEnv() below FALLS BACK rather
// than clamping, so a host window exceeding this cap is silently ignored and the effective window
// reverts to DEFAULT_DECISION_TIMEOUT_MS with no error anywhere — which is precisely what happened
// when the window was raised to 15 minutes against a 10-minute cap. Headroom is deliberate so a
// future increase does not repeat it; humanWindowCoupling.test.ts ties the two constants together.
// A generous HUMAN window is safe: the seconds-scale liveness clock below is what actually protects
// against a hung gate, and expiry still fails closed.
const MAX_DECISION_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_LIVENESS_TIMEOUT_MS = 5_000;
const MAX_LIVENESS_TIMEOUT_MS = 10_000;
const WATCHDOG_BUFFER_MS = 250;

function failClosed() {
  process.exit(2);
}

process.on('uncaughtException', failClosed);
process.on('unhandledRejection', failClosed);

function boundedEnv(name, fallback, min, max) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

/** Human decision window. A policy lapse is returned by the host as a normal deny. */
function decisionTimeoutMs() {
  return boundedEnv('UNODE_CLAUDE_TOOL_GATE_TIMEOUT_MS', DEFAULT_DECISION_TIMEOUT_MS, 50, MAX_DECISION_TIMEOUT_MS);
}

/** Loopback gate health. Missing ACK/heartbeat is a transport failure and fails closed quickly. */
function livenessTimeoutMs() {
  const configured = Number.parseInt(process.env.UNODE_CLAUDE_TOOL_GATE_LIVENESS_MS || '', 10);
  if (Number.isFinite(configured) && configured >= 25 && configured <= MAX_LIVENESS_TIMEOUT_MS) {
    return configured;
  }
  // Test/constrained callers that set only the historical timeout variable retain a short fail-closed
  // liveness window. Production wrappers set the two clocks explicitly.
  return Math.min(decisionTimeoutMs(), DEFAULT_LIVENESS_TIMEOUT_MS);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let value = '';
    let bytes = 0;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes > MAX_INPUT_BYTES) {
        reject(new Error('hook input exceeds size limit'));
        return;
      }
      value += chunk;
    });
    process.stdin.once('end', () => resolve(value));
    process.stdin.once('error', reject);
  });
}

/**
 * The gate replies with newline-delimited JSON: an immediate {type:"ack"}, periodic heartbeats, then the
 * final {allow,reason}. This splits human decision time from the loopback transport-health deadline.
 */
function postGate(url, token, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port || target.pathname !== '/gate') {
      reject(new Error('invalid gate endpoint'));
      return;
    }
    const payload = JSON.stringify(body);
    let settled = false;
    let livenessTimer;
    let request;
    let responseBytes = 0;
    let pending = '';

    const clearLiveness = () => {
      if (livenessTimer) {
        clearTimeout(livenessTimer);
        livenessTimer = undefined;
      }
    };
    const fail = (error) => {
      if (settled) { return; }
      settled = true;
      clearLiveness();
      request?.destroy();
      reject(error);
    };
    const succeed = (decision) => {
      if (settled) { return; }
      settled = true;
      clearLiveness();
      resolve(decision);
    };
    const resetLiveness = () => {
      clearLiveness();
      livenessTimer = setTimeout(() => fail(new Error('gate liveness heartbeat timed out')), livenessTimeoutMs());
    };
    const consume = (line) => {
      const text = line.trim();
      if (!text || settled) { return; }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        fail(error);
        return;
      }
      if (parsed && (parsed.type === 'ack' || parsed.type === 'heartbeat')) {
        resetLiveness();
        return;
      }
      if (!parsed || typeof parsed.allow !== 'boolean' || (parsed.reason !== undefined && typeof parsed.reason !== 'string')) {
        fail(new Error('malformed gate response'));
        return;
      }
      succeed(parsed);
    };

    request = http.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (response) => {
      if (response.statusCode !== 200) {
        fail(new Error(`gate returned HTTP ${response.statusCode || 0}`));
        return;
      }
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        responseBytes += Buffer.byteLength(chunk, 'utf8');
        if (responseBytes > MAX_RESPONSE_BYTES) {
          fail(new Error('gate response exceeds size limit'));
          return;
        }
        pending += chunk;
        let newline;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          consume(line);
          if (settled) { return; }
        }
      });
      response.once('error', fail);
      response.once('end', () => {
        if (pending.trim()) {
          consume(pending);
        }
        if (!settled) {
          fail(new Error('gate ended without a decision'));
        }
      });
    });
    request.once('error', fail);
    resetLiveness();
    request.end(payload);
  });
}

async function main() {
  const endpoint = process.env.UNODE_CLAUDE_TOOL_GATE_URL;
  const token = process.env.UNODE_CLAUDE_TOOL_GATE_TOKEN;
  if (!endpoint || !token) {
    throw new Error('missing gate credentials');
  }
  // Only stdin is governed by this one-shot watchdog. Once an authenticated gate has ACKed, `postGate`
  // owns the liveness deadline and resets it on each heartbeat; a human approval may legitimately outlive
  // several liveness intervals.
  const stdinWatchdog = setTimeout(failClosed, livenessTimeoutMs() + WATCHDOG_BUFFER_MS);
  let raw;
  try {
    raw = await readStdin();
  } finally {
    clearTimeout(stdinWatchdog);
  }
  const input = JSON.parse(raw);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('hook input must be an object');
  }
  const decision = await postGate(endpoint, token, input);
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision.allow ? 'allow' : 'deny',
      permissionDecisionReason: decision.reason || (decision.allow ? 'Allowed by UnodeAi.' : 'Denied by UnodeAi.'),
    },
  })}\n`);
}

main()
  .catch(failClosed);
