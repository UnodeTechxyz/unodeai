import { describe, expect, it } from 'vitest';
import { punctuateMountDetail } from '../McpMountNotice';

describe('punctuateMountDetail', () => {
  it.each([
    ['missing PATH entry.', 'missing PATH entry.'],
    ['approval declined!', 'approval declined!'],
    ['retry?', 'retry?'],
    ['connection closed', 'connection closed.'],
  ])('adds exactly one terminal mark to %s', (detail, expected) => {
    expect(punctuateMountDetail(detail)).toBe(expected);
  });
});
