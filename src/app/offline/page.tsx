export const metadata = { title: 'Offline' };

export default function OfflinePage() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-xl font-semibold">You are offline</h1>
      <p className="max-w-sm text-sm text-muted">ATLAS needs a connection to load investigations and to query providers. Nothing is collected or cached while offline. Reconnect and reload this page.</p>
    </div>
  );
}
