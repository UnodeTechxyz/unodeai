import { interruptionDetail, type InterruptionDetail } from './InterruptionDetail';

/** Called only for App Server turn failures, never model text or command output. */
export function codexNativeErrorDetail(error: unknown, folder: string): InterruptionDetail {
  const detail = interruptionDetail(error);
  if (process.platform === 'win32' && error instanceof Error
    && /\bhelper_unknown_error\b|setup refresh had errors|failed to create unified exec process/i.test(error.message.slice(0, 16_384))
    && folder.length > 0 && folder.length <= 1000 && !/[\x00-\x1f\x7f]/.test(folder)) {
    detail.codexSandboxFolder = interruptionDetail(new Error(folder)).message;
  }
  return detail;
}
