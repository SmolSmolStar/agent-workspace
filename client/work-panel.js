// Full-screen in-app shell around WorkPage, matching how Tasks opens.
class WorkPanel {
  constructor(orchestrator) {
    this.orchestrator = orchestrator;
    this.page = null;
    this._keyHandler = null;
  }

  isOpen() {
    return !!document.getElementById('work-panel');
  }

  toggle() {
    if (this.isOpen()) this.close();
    else this.show();
  }

  close() {
    document.getElementById('work-panel')?.remove();
    if (this._keyHandler) {
      document.removeEventListener('keydown', this._keyHandler);
      this._keyHandler = null;
    }
  }

  async show() {
    this.close();

    const modal = document.createElement('div');
    modal.id = 'work-panel';
    modal.className = 'modal work-modal';
    modal.innerHTML = `
      <div class="modal-content work-content">
        <header class="wp-page-head">
          <h1>Work<span class="wp-subtitle">where the time is going, by the five thieves</span></h1>
          <div class="wp-toolbar-controls">
            <button class="wp-btn" id="work-open-tab">Open in a tab</button>
            <button class="wp-btn" id="work-close">Close</button>
          </div>
        </header>
        <div class="wp-scroll"><div class="wp-root" id="work-root"></div></div>
      </div>`;
    document.body.appendChild(modal);

    modal.querySelector('#work-close').addEventListener('click', () => this.close());
    modal.querySelector('#work-open-tab').addEventListener('click', () => {
      window.open(`${window.location.origin}/work.html`, '_blank', 'noopener');
    });

    this._keyHandler = (event) => { if (event.key === 'Escape') this.close(); };
    document.addEventListener('keydown', this._keyHandler);

    this.page = new WorkPage(modal.querySelector('#work-root'));
    await this.page.load();
  }
}

if (typeof window !== 'undefined') window.WorkPanel = WorkPanel;
