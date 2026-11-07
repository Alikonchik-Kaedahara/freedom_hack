// CQA.D365Bridge — a thin adapter between the widget and Microsoft Dynamics 365.
//
// Embedding (HTML web resource or any page):
//   <link rel="stylesheet" href="css/app.css">
//   <div id="cqa"></div>
//   <script type="module" src="js/app.js"></script>
//   <script> FreedomCQA.mount(document.getElementById('cqa'), { apiBase: 'https://…', groupId: 'DEV' }); </script>
//
// Inside Dynamics 365 the bridge finds Xrm (own window or parent frame), reads the current user
// and record id, and talks to the host form with postMessage:
//   widget → host: { source: 'freedom-cqa', type: 'ready' | 'evaluated' | 'route', ... }
//   host → widget: { source: 'd365', type: 'open-dialog', conversationId } | { type: 'set-group', groupId }

const SOURCE = 'freedom-cqa';

function findXrm() {
  try { if (window.Xrm?.Utility) return window.Xrm; } catch { /* no access */ }
  try { if (window.parent && window.parent !== window && window.parent.Xrm?.Utility) return window.parent.Xrm; } catch { /* cross-origin */ }
  return null;
}

export const D365Bridge = {
  xrm: null,
  context: {},
  handlers: {},

  detect() {
    this.xrm = findXrm();
    const ctx = { embedded: window.parent !== window, xrm: !!this.xrm };
    if (this.xrm) {
      try {
        const g = this.xrm.Utility.getGlobalContext();
        ctx.userName = g.userSettings?.userName;
        ctx.orgUrl = g.getClientUrl?.();
      } catch { /* older API */ }
    }
    // Web resources receive the record id and a custom "data" string in the query string.
    const q = new URLSearchParams(location.search);
    if (q.get('id')) ctx.recordId = q.get('id').replace(/[{}]/g, '');
    if (q.get('data')) {
      const data = new URLSearchParams(decodeURIComponent(q.get('data')));
      for (const k of ['groupId', 'conversationId', 'apiBase']) if (data.get(k)) ctx[k] = data.get(k);
    }
    this.context = ctx;
    return ctx;
  },

  /** True when the widget is attached to an Xrm host: the real CRM, or the emulated host of the preview. */
  get ready() { return !!this.xrm; },
  simulated: false,

  /**
   * Host preview: the page plays the role of Dynamics 365 and provides a minimal Xrm object
   * (global context, WebApi stub), so the same bridge code path runs as inside the CRM.
   * A real Xrm always wins and is never replaced.
   */
  connectEmulatedHost() {
    if (this.xrm && !this.simulated) return;
    this.xrm = {
      Utility: { getGlobalContext: () => ({ userSettings: { userName: 'Супервайзер (демо)' }, getClientUrl: () => location.origin }) },
      WebApi: { retrieveMultipleRecords: async () => ({ entities: [] }), retrieveRecord: async () => ({}) },
      Page: { data: { entity: { getId: () => this.context.recordId || '' } } },
    };
    this.simulated = true;
    this.context = { ...this.context, xrm: true, emulated: true, userName: 'Супервайзер (демо)' };
  },
  disconnectEmulatedHost() {
    if (!this.simulated) return;
    this.xrm = null;
    this.simulated = false;
    this.context = { ...this.context, xrm: false, emulated: false };
  },

  post(type, payload = {}) {
    if (window.parent === window) return;
    window.parent.postMessage({ source: SOURCE, type, ...payload }, '*');
  },

  listen(handlers) {
    this.handlers = handlers;
    window.addEventListener('message', (e) => {
      const m = e.data;
      if (!m || typeof m !== 'object' || m.source !== 'd365' || typeof m.type !== 'string') return;
      if (m.type === 'open-dialog' && typeof m.conversationId === 'string') this.handlers.openDialog?.(m.conversationId);
      if (m.type === 'set-group' && typeof m.groupId === 'string') this.handlers.setGroup?.(m.groupId);
    });
  },
};
