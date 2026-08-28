export function RouteLoading({ label, settings = false }: { label: string; settings?: boolean }) {
  if (settings) {
    return (
      <div aria-busy="true" className="settings-page route-loading-settings" role="status">
        <nav
          aria-label="Settings navigation"
          className="settings-navigation route-loading-settings__navigation"
        />
        <div className="settings-content route-loading-settings__content">
          <div className="settings-heading">
            <p className="page-eyebrow">Settings</p>
            <h1>{label}</h1>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div aria-busy="true" className="page-scroll library-page" role="status">
      <header className="section-header">
        <div className="section-title">
          <div><p className="page-eyebrow">Library</p><h1>{label}</h1></div>
        </div>
      </header>
    </div>
  );
}
