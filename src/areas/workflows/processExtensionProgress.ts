/** Wire IPC progress events from Python/JS process extensions into workflow UI state. */
export function bindProcessExtensionProgress(
  extensionId: string,
  blockIndex: number,
  blockTotal: number,
  onUpdate: (blockProgress: number, blockStep: string, overallProgress: number) => void,
): () => void {
  const handler = (data: { extensionId: string; percent: number; label: string }) => {
    if (data.extensionId !== extensionId) return
    const overall =
      blockTotal > 0
        ? Math.round((blockIndex / blockTotal) * 100 + data.percent / blockTotal)
        : data.percent
    onUpdate(data.percent, data.label, overall)
  }
  window.electron.extensions.onProcessProgress(handler)
  return () => window.electron.extensions.offProcessProgress()
}
