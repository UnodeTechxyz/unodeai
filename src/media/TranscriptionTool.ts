export const TRANSCRIBE_AUDIO_TOOL = 'transcribe_audio';

export const TRANSCRIBE_AUDIO_SPEC = { type: 'function' as const, function: {
  name: TRANSCRIBE_AUDIO_TOOL,
  description: 'Transcribe one WAV or MP3 recording using the member’s configured audio connection. Use a readable file path or the asset_id of a recording attached to this task. Each recording can be up to 25,000,000 bytes and 25 minutes. UnodeAi saves the exact text automatically next to the recording or in transcripts/ for an attachment, under the usual write approval. If the user requested a different destination, pass save_path. Use the actual saved path in the result. Never re-type the transcript into write_file. If transcription is incomplete, report the missing range and do not save a complete transcript.',
  parameters: { type: 'object' as const, additionalProperties: false, properties: {
    path: { type: 'string', description: 'One readable WAV or MP3 file path. Leave out asset_id when supplying a path.' },
    asset_id: { type: 'string', description: 'Opaque asset ID of an attached WAV or MP3. Leave out path when supplying an asset ID.' },
    save_path: { type: 'string', description: 'Optional writable workspace file path for the exact transcript in UTF-8.' },
  }, required: [] as string[] },
} };
