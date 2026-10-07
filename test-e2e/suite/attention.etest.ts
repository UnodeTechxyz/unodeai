import * as assert from 'assert';
import * as vscode from 'vscode';

const EXT_ID = 'unode.unodeai';
const AUDIO_STATES = ['running', 'suspended', 'closed', 'interrupted', 'unavailable', 'error'];

type PlaybackProbe = (fixture: { e2e: true }, options: { hidden: boolean }) => Promise<
  { audioState: string; started: boolean; surface: string } | { timedOut: true }
>;

/**
 * v0.9.88 §5.11. In a real VS Code the Chat webview answers an attention request with its own playback report,
 * and the host validates it, visible and hidden. The probe run on 2026-09-26 found the chime cannot start with no
 * user gesture (`suspended`); the automated host cannot make a trusted gesture, so playback itself is checked by
 * ear in the field test, and this test pins the round trip and records the state it saw.
 */
describe('attention signal playback report (v0.9.88)', () => {
  for (const hidden of [false, true]) {
    it(`the ${hidden ? 'hidden' : 'visible'} Chat Workbench reports whether the chime started`, async () => {
      const ext = vscode.extensions.getExtension(EXT_ID);
      assert.ok(ext, `extension ${EXT_ID} should be present`);
      await ext!.activate();
      const probe = (ext!.exports as { __testAttentionPlayback?: PlaybackProbe }).__testAttentionPlayback;
      assert.strictEqual(typeof probe, 'function', 'the extension must expose the attention playback probe in Test mode');

      const result = await probe!({ e2e: true }, { hidden });
      console.log(`[attention-probe] ${hidden ? 'hidden' : 'visible'} workbench: ${JSON.stringify(result)}`);
      assert.ok(!('timedOut' in result), 'the Chat webview must answer the attention request');
      if (!('timedOut' in result)) {
        assert.strictEqual(result.surface, 'workbench');
        assert.ok(AUDIO_STATES.includes(result.audioState), `unknown audio state ${result.audioState}`);
        assert.strictEqual(result.started, result.audioState === 'running');
      }
    });
  }
});
