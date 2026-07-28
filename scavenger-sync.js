(() => {
  'use strict';

  const APP_ID = 'scavenger-hunt';
  const MANIFEST_VERSION = 1;
  const store = window.ScavengerStore;
  const bridge = window.ScavengerAppBridge;
  const safety = window.ScavengerSyncSafety;
  const toolbar = document.querySelector('.toolbar');
  const saveStatus = document.getElementById('save-status');

  if (!document.body || !toolbar || !store || !bridge || !safety) return;

  const openButton = document.createElement('button');
  openButton.type = 'button';
  openButton.className = 'scavenger-sync-open';
  openButton.dataset.state = 'disconnected';
  openButton.textContent = 'Sync & backup';
  toolbar.insertBefore(openButton, saveStatus);

  const dialog = document.createElement('dialog');
  dialog.className = 'scavenger-sync-dialog';
  dialog.setAttribute('aria-labelledby', 'scavenger-sync-title');
  dialog.innerHTML = `
    <div class="scavenger-sync-window">
      <div class="scavenger-sync-heading">
        <div>
          <p class="scavenger-sync-kicker">RYAN-ONLY APP SYNC</p>
          <h2 id="scavenger-sync-title">Sync & backup</h2>
        </div>
        <button type="button" class="scavenger-sync-close" data-scavenger-sync-close
          aria-label="Close sync and backup window">×</button>
      </div>
      <p class="scavenger-sync-copy">
        Camp name, classes, and lesson templates can sync between Ryan’s browsers.
        The active class, event, hunt, round, and athlete stay on this device.
      </p>
      <p class="scavenger-sync-safety">
        Only <code>star-search-offline-v1</code> is read. Other browser storage is never
        scanned, replaced, or cleared.
      </p>
      <div class="scavenger-sync-state" data-scavenger-sync-state
        data-state="disconnected">
        <strong data-scavenger-sync-state-label>Disconnected</strong>
        <span data-scavenger-sync-state-message>Local camp data stays on this device.</span>
      </div>
      <p class="scavenger-sync-alert" data-scavenger-sync-alert role="alert" hidden></p>
      <div class="scavenger-sync-actions">
        <button type="button" class="is-primary" data-scavenger-sync-connect
          data-sync-action>Connect as Ryan</button>
        <button type="button" data-scavenger-sync-now data-sync-action>Sync now</button>
        <button type="button" data-scavenger-sync-backup data-sync-action>
          Download exact local backup
        </button>
        <button type="button" data-scavenger-sync-recover data-sync-action hidden>
          Back up & normalize historical data
        </button>
        <button type="button" data-scavenger-sync-preview data-sync-action>
          Create backup & preview
        </button>
        <button type="button" data-scavenger-sync-disconnect data-sync-action>
          Disconnect
        </button>
        <button type="button" data-scavenger-sync-reset data-sync-action>
          Reset device connection
        </button>
      </div>
      <section class="scavenger-sync-review" data-scavenger-sync-review hidden
        aria-labelledby="scavenger-sync-review-title">
        <h3 id="scavenger-sync-review-title">Migration preview</h3>
        <p data-scavenger-sync-counts></p>
        <p class="scavenger-sync-zero-write" data-scavenger-sync-zero-write></p>
        <div class="scavenger-sync-records" data-scavenger-sync-records></div>
        <button type="button" class="is-primary" data-scavenger-sync-apply
          data-sync-action disabled>Apply reviewed migration</button>
      </section>
      <section class="scavenger-sync-conflicts" data-scavenger-sync-conflicts hidden
        aria-labelledby="scavenger-sync-conflicts-title">
        <h3 id="scavenger-sync-conflicts-title">Sync conflicts</h3>
        <p>Choose the complete record deliberately. No value is selected automatically.</p>
        <div class="scavenger-sync-conflict-list"
          data-scavenger-sync-conflict-list></div>
      </section>
      <p class="scavenger-sync-footnote">
        Authentication stays only in this open page. Local changes remain saved if the
        service is disconnected or offline.
      </p>
    </div>
  `;
  document.body.append(dialog);

  const closeButton = dialog.querySelector('[data-scavenger-sync-close]');
  const connectButton = dialog.querySelector('[data-scavenger-sync-connect]');
  const syncButton = dialog.querySelector('[data-scavenger-sync-now]');
  const backupButton = dialog.querySelector('[data-scavenger-sync-backup]');
  const recoverButton = dialog.querySelector('[data-scavenger-sync-recover]');
  const previewButton = dialog.querySelector('[data-scavenger-sync-preview]');
  const disconnectButton = dialog.querySelector('[data-scavenger-sync-disconnect]');
  const resetButton = dialog.querySelector('[data-scavenger-sync-reset]');
  const applyButton = dialog.querySelector('[data-scavenger-sync-apply]');
  const stateBox = dialog.querySelector('[data-scavenger-sync-state]');
  const stateLabel = dialog.querySelector('[data-scavenger-sync-state-label]');
  const stateMessage = dialog.querySelector('[data-scavenger-sync-state-message]');
  const alertBox = dialog.querySelector('[data-scavenger-sync-alert]');
  const review = dialog.querySelector('[data-scavenger-sync-review]');
  const counts = dialog.querySelector('[data-scavenger-sync-counts]');
  const zeroWrite = dialog.querySelector('[data-scavenger-sync-zero-write]');
  const records = dialog.querySelector('[data-scavenger-sync-records]');
  const conflicts = dialog.querySelector('[data-scavenger-sync-conflicts]');
  const conflictList = dialog.querySelector('[data-scavenger-sync-conflict-list]');
  const actionButtons = Array.from(dialog.querySelectorAll('[data-sync-action]'));

  let client = null;
  let preferencesHandle = null;
  let classesHandle = null;
  let lessonsHandle = null;
  let previewResult = null;
  let busy = false;
  let initialized = false;
  let conflictRender = 0;
  let restoreFocus = null;
  let ready = Promise.resolve();
  let stagingDrain = Promise.resolve();
  let stagingActive = false;
  const pendingStages = new Map();

  const stateLabels = Object.freeze({
    disconnected: 'Disconnected',
    review: 'Migration review required',
    syncing: 'Syncing',
    synced: 'Synced',
    offline: 'Offline',
    conflict: 'Conflict needs review',
  });

  const showAlert = (message = '') => {
    alertBox.hidden = !message;
    alertBox.textContent = message;
  };

  const setBusy = next => {
    busy = next;
    dialog.setAttribute('aria-busy', String(next));
    actionButtons.forEach(button => {
      if (button === applyButton && !next) return;
      button.disabled = next;
    });
    if (!next) updateApplyAvailability();
  };

  const downloadJson = (payload, filename) => {
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const downloadRawBackup = () => {
    const today = new Date().toISOString().slice(0, 10);
    downloadJson(
      store.rawBackup(),
      `gymnastics-scavenger-hunt-browser-local-raw-backup-${today}.json`
    );
  };

  const requireWriteSource = metadata => {
    if (!metadata || !['local', 'remote-migration'].includes(metadata.source)) {
      throw new Error('The sync client requested an invalid Scavenger Hunt local-write source.');
    }
  };

  const requireRemoteSource = metadata => {
    if (!metadata || !['remote', 'migration'].includes(metadata.source)) {
      throw new Error('The sync client requested an invalid Scavenger Hunt remote-write source.');
    }
  };

  const whenStagingSettled = async () => {
    while (stagingActive || pendingStages.size) {
      const currentDrain = stagingDrain;
      await currentDrain.catch(() => {});
      if (currentDrain === stagingDrain && !stagingActive && !pendingStages.size) return;
    }
  };

  const waitForEditorIdle = async () => {
    if (!bridge.hasActiveEditor()) return;
    await bridge.whenEditorIdle();
  };

  const coordinateRemoteApply = safety.createRemoteApplyQueue({
    getRevision: () => store.getRevision(),
    whenLocalIdle: () => store.whenLocalIdle(),
    whenStagingSettled,
    waitForEditorIdle,
  });

  const queueRemoteApply = (metadata, operation) => {
    requireRemoteSource(metadata);
    return coordinateRemoteApply(metadata, operation);
  };

  const preferencesAdapter = {
    scope: APP_ID,
    appId: APP_ID,
    collection: 'preferences',
    recordId: 'current',
    schemaVersion: 1,
    validate: value => store.isPreferencesValue(value),
    readLocal: () => {
      const state = store.readState();
      return state ? store.preferencesValue(state) : undefined;
    },
    writeLocal: (value, metadata) => {
      requireWriteSource(metadata);
      if (metadata.source === 'local') {
        return store.verifyCurrentPreferences(value, {
          deleted: Boolean(metadata.deleted),
        });
      }
      return queueRemoteApply({ source: 'migration' }, fence => (
        store.applyPreferences(value, {
          source: 'migration',
          deleted: Boolean(metadata.deleted),
          ...fence,
        })
      ));
    },
    applyRemote: (value, metadata) => queueRemoteApply(metadata, fence => (
      store.applyPreferences(value, {
        source: metadata.source,
        deleted: Boolean(metadata.deleted),
        ...fence,
      })
    )),
  };

  const classesAdapter = {
    scope: APP_ID,
    appId: APP_ID,
    collection: 'classes',
    schemaVersion: 1,
    validate: value => store.isClassValue(value),
    listLocal: () => store.listClassRecords(),
    writeLocal: (recordId, value, metadata) => {
      requireWriteSource(metadata);
      if (metadata.source === 'local') {
        return store.verifyCurrentClassRecord(recordId, value, {
          deleted: Boolean(metadata.deleted),
        });
      }
      return queueRemoteApply({ source: 'migration' }, fence => (
        store.applyClassRecord(recordId, value, {
          source: 'migration',
          deleted: Boolean(metadata.deleted),
          ...fence,
        })
      ));
    },
    applyRemote: (recordId, value, metadata) => queueRemoteApply(metadata, fence => (
      store.applyClassRecord(recordId, value, {
        source: metadata.source,
        deleted: Boolean(metadata.deleted),
        ...fence,
      })
    )),
  };

  const lessonsAdapter = {
    scope: APP_ID,
    appId: APP_ID,
    collection: 'lesson-templates',
    schemaVersion: 1,
    validate: value => store.isLessonValue(value),
    listLocal: () => store.listLessonRecords(),
    writeLocal: (recordId, value, metadata) => {
      requireWriteSource(metadata);
      if (metadata.source === 'local') {
        return store.verifyCurrentLessonRecord(recordId, value, {
          deleted: Boolean(metadata.deleted),
        });
      }
      return queueRemoteApply({ source: 'migration' }, fence => (
        store.applyLessonRecord(recordId, value, {
          source: 'migration',
          deleted: Boolean(metadata.deleted),
          ...fence,
        })
      ));
    },
    applyRemote: (recordId, value, metadata) => queueRemoteApply(metadata, fence => (
      store.applyLessonRecord(recordId, value, {
        source: metadata.source,
        deleted: Boolean(metadata.deleted),
        ...fence,
      })
    )),
  };

  const invalidatePreview = () => {
    previewResult = null;
    review.hidden = true;
    records.replaceChildren();
    applyButton.disabled = true;
  };

  const stageLocalChange = async detail => {
    await ready;
    const changes = await store.diffRecords(detail.oldRaw, detail.newRaw);
    for (const change of changes.classes.filter(item => !item.deleted)) {
      await classesHandle.save(change.recordId, change.value);
    }
    for (const change of changes.lessons.filter(item => !item.deleted)) {
      await lessonsHandle.save(change.recordId, change.value);
    }
    if (changes.preferencesChanged) {
      await preferencesHandle.save(changes.preferences);
    }
    for (const change of changes.classes.filter(item => item.deleted)) {
      await classesHandle.remove(change.recordId);
    }
    for (const change of changes.lessons.filter(item => item.deleted)) {
      await lessonsHandle.remove(change.recordId);
    }
  };

  const drainLocalStages = () => {
    if (stagingActive) return stagingDrain;
    stagingActive = true;
    stagingDrain = (async () => {
      while (pendingStages.size) {
        const [key, detail] = pendingStages.entries().next().value;
        pendingStages.delete(key);
        await stageLocalChange(detail);
      }
    })().finally(() => {
      stagingActive = false;
      if (pendingStages.size) void drainLocalStages();
    });
    return stagingDrain;
  };

  const enqueueLocalStage = detail => {
    const pending = pendingStages.get(detail.key);
    pendingStages.set(detail.key, pending
      ? { ...detail, oldRaw: pending.oldRaw }
      : { ...detail });
    return drainLocalStages();
  };

  window.addEventListener(store.changeEvent, event => {
    const detail = event.detail;
    if (!detail || !['local', 'recovery'].includes(detail.source)) return;
    invalidatePreview();
    void enqueueLocalStage(detail).catch(error => {
      showAlert(
        `${error instanceof Error ? error.message : 'Synchronization staging failed.'} `
        + 'The change is still saved in this browser.'
      );
    });
  });

  window.addEventListener(store.errorEvent, event => {
    const message = event.detail?.message;
    if (message) showAlert(message);
  });

  const updateApplyAvailability = () => {
    applyButton.disabled = busy
      || !previewResult
      || !safety.migrationAllowed(previewResult.preview)
      || Boolean(records.querySelector('[data-migration-blocked]'));
  };

  const friendlyRecordName = item => {
    if (item.collection === 'preferences') return 'Camp name preference';
    if (item.collection === 'classes') return `Class · ${item.recordId}`;
    if (item.collection === 'lesson-templates') return `Lesson · ${item.recordId}`;
    return `${item.collection} · ${item.recordId}`;
  };

  const renderPreview = result => {
    previewResult = result;
    review.hidden = false;
    records.replaceChildren();
    counts.textContent =
      `${result.preview.localCount} local · ${result.preview.remoteCount} synchronized · `
      + `${result.preview.orphanedCount} orphaned`;
    const zero = result.preview.writesPerformed === 0;
    zeroWrite.textContent = zero
      ? 'ZERO-WRITE PREVIEW CONFIRMED · No local or synchronized record changed.'
      : 'PREVIEW BLOCKED · The service did not confirm zero writes.';

    for (const item of result.preview.review) {
      const row = document.createElement('div');
      row.className = 'scavenger-sync-record';
      const title = document.createElement('strong');
      title.textContent = friendlyRecordName(item);
      const status = document.createElement('span');
      status.textContent = `Status: ${String(item.status || 'unknown').replaceAll('-', ' ')}`;
      row.append(title, status);
      if (!['local-only', 'same'].includes(item.status)) {
        row.dataset.migrationBlocked = 'true';
        row.classList.add('scavenger-sync-blocked');
        const message = document.createElement('span');
        message.textContent =
          'This first-device migration cannot choose or overwrite a synchronized record.';
        row.append(message);
      }
      records.append(row);
    }

    if (!zero || result.preview.remoteCount > 0 || result.preview.orphanedCount > 0) {
      const blocked = document.createElement('p');
      blocked.dataset.migrationBlocked = 'true';
      blocked.className = 'scavenger-sync-blocked';
      if (!zero) {
        blocked.textContent =
          'The service did not prove a zero-write preview. Migration is blocked.';
      } else if (result.preview.remoteCount > 0) {
        blocked.textContent =
          'Synchronized Scavenger Hunt records already exist. Migration is blocked; '
          + 'local data was not changed.';
      } else {
        blocked.textContent =
          `${result.preview.orphanedCount} orphaned synchronized record`
          + `${result.preview.orphanedCount === 1 ? '' : 's'} cannot be assigned safely. `
          + 'Migration is blocked; local data was not changed.';
      }
      records.prepend(blocked);
    }

    if (!result.preview.review.length) {
      const empty = document.createElement('p');
      empty.textContent = 'No registered local or synchronized records were found.';
      records.append(empty);
    }
    updateApplyAvailability();
  };

  const renderConflicts = async () => {
    if (!client) return;
    const renderId = ++conflictRender;
    const items = await client.listConflicts();
    if (renderId !== conflictRender) return;
    conflicts.hidden = items.length === 0;
    conflictList.replaceChildren();
    for (const item of items) {
      const parts = String(item.recordKey || '').split('\u001f');
      const collection = parts[2] || '';
      const recordId = parts[3] || '';
      const card = document.createElement('div');
      card.className = 'scavenger-sync-conflict';
      const title = document.createElement('strong');
      title.textContent = friendlyRecordName({ collection, recordId });
      const reason = document.createElement('span');
      reason.textContent = `Reason: ${item.reason || 'conflict'}`;
      const actions = document.createElement('div');
      actions.className = 'scavenger-sync-conflict-actions';
      const revision = Number.isInteger(item.current?.revision) ? item.current.revision : 0;
      const choices = [['Keep this device', 'keep-local']];
      if (item.current && !item.current.deleted) {
        choices.push(['Accept synchronized record', 'accept-remote']);
      }
      for (const [label, strategy] of choices) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.addEventListener('click', () => {
          void runAction(async () => {
            await client.resolveConflict(item.recordKey, {
              strategy,
              expectedRemoteRevision: revision,
            });
            await renderConflicts();
          });
        });
        actions.append(button);
      }
      card.append(title, reason, actions);
      conflictList.append(card);
    }
  };

  const showState = state => {
    const mode = state?.mode || 'disconnected';
    openButton.dataset.state = mode;
    openButton.title = state?.message || 'Open sync and backup';
    stateBox.dataset.state = mode;
    stateLabel.textContent = stateLabels[mode] || mode;
    stateMessage.textContent =
      state?.message || 'Local Scavenger Hunt data remains on this device.';
    connectButton.hidden = mode !== 'disconnected';
    syncButton.hidden = !['synced', 'offline', 'conflict'].includes(mode);
    previewButton.hidden = mode !== 'review';
    disconnectButton.hidden = mode === 'disconnected';
    resetButton.hidden = mode !== 'disconnected';
    if (mode === 'conflict') void renderConflicts();
    else {
      conflictRender += 1;
      conflicts.hidden = true;
      conflictList.replaceChildren();
    }
  };

  const runAction = async action => {
    if (busy) return;
    setBusy(true);
    showAlert('');
    try {
      await action();
    } catch (error) {
      showAlert(error instanceof Error ? error.message : 'The action could not be completed safely.');
    } finally {
      setBusy(false);
    }
  };

  const initialize = async () => {
    const inspection = store.inspect();
    recoverButton.hidden = inspection.status !== 'recoverable';
    if (inspection.status === 'invalid') throw inspection.error;
    if (inspection.status === 'recoverable') {
      throw new Error(
        `Recognized historical ${inspection.format} data. Download the exact raw backup `
        + 'and use the historical-data recovery action before synchronization.'
      );
    }
    if (!window.RyanAppSync?.create) {
      throw new Error('Ryan App Sync is unavailable. Exact raw local backup still works.');
    }
    client = window.RyanAppSync.create({
      appId: APP_ID,
      manifestVersion: MANIFEST_VERSION,
      serviceOrigin: 'https://ryan-app-sync.ryan-666-mp3.chatgpt.site',
      deviceLabel: `Scavenger Hunt · ${navigator.platform || 'browser'}`,
      showStatus: false,
    });
    client.onStateChange(showState);
    preferencesHandle = await client.register(preferencesAdapter);
    classesHandle = await client.registerCollection(classesAdapter);
    lessonsHandle = await client.registerCollection(lessonsAdapter);
    await client.finalizeRegistration();
    initialized = true;
    recoverButton.hidden = true;
    showState(client.getState());
  };

  const beginInitialize = () => {
    ready = initialize().catch(error => {
      showAlert(error instanceof Error ? error.message : 'Ryan App Sync could not initialize.');
      stateMessage.textContent =
        'Exact raw local backup remains available; synchronization is unavailable.';
      connectButton.hidden = true;
      syncButton.hidden = true;
      previewButton.hidden = true;
      disconnectButton.hidden = true;
      throw error;
    });
    ready.catch(() => {});
    return ready;
  };

  beginInitialize();

  openButton.addEventListener('click', () => {
    restoreFocus = document.activeElement;
    const error = store.getLastError();
    showAlert(error ? error.message : '');
    if (!dialog.open) dialog.showModal();
    closeButton.focus();
  });

  closeButton.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    restoreFocus?.focus?.();
    restoreFocus = null;
  });

  connectButton.addEventListener('click', () => {
    void runAction(async () => {
      await ready;
      await client.connect();
    });
  });

  syncButton.addEventListener('click', () => {
    void runAction(async () => {
      await ready;
      await client.sync();
      await renderConflicts();
    });
  });

  backupButton.addEventListener('click', () => {
    void runAction(async () => {
      downloadRawBackup();
      if (!initialized) {
        showAlert('Exact raw local backup downloaded. Safe sync is unavailable on this page.');
      }
    });
  });

  recoverButton.addEventListener('click', () => {
    void runAction(async () => {
      downloadRawBackup();
      await store.normalizeRecoverable(bridge.getState(), { backupConfirmed: true });
      initialized = false;
      client = null;
      preferencesHandle = null;
      classesHandle = null;
      lessonsHandle = null;
      await beginInitialize();
      showAlert('Exact raw backup downloaded and historical data normalized safely.');
    });
  });

  previewButton.addEventListener('click', () => {
    void runAction(async () => {
      downloadRawBackup();
      await ready;
      renderPreview(await client.previewMigration({
        sourceKey: store.stateKey,
        downloadBackup: false,
      }));
    });
  });

  applyButton.addEventListener('click', () => {
    void runAction(async () => {
      if (!previewResult || previewResult.preview.writesPerformed !== 0) {
        throw new Error('Create and review a fresh zero-write migration preview.');
      }
      if (previewResult.preview.remoteCount > 0) {
        throw new Error(
          'First-device migration is blocked because synchronized Scavenger Hunt records exist.'
        );
      }
      if (previewResult.preview.orphanedCount > 0) {
        throw new Error(
          'Migration is blocked because orphaned synchronized records need review.'
        );
      }
      await client.applyMigration(previewResult.plan, {});
      invalidatePreview();
      await renderConflicts();
    });
  });

  disconnectButton.addEventListener('click', () => {
    void runAction(async () => {
      await ready;
      await client.disconnect();
      invalidatePreview();
    });
  });

  resetButton.addEventListener('click', () => {
    void runAction(async () => {
      await ready;
      await client.resetDevice();
      invalidatePreview();
      showAlert(
        'Device connection reset. Local Scavenger Hunt data was preserved; '
        + 'connect again and review a fresh preview.'
      );
    });
  });

  window.ScavengerSync = Object.freeze({
    appId: APP_ID,
    manifestVersion: MANIFEST_VERSION,
    get ready() {
      return ready;
    },
    whenStagingSettled,
    enqueueLocalStage,
    getClient: () => client,
    getHandles: () => ({
      preferences: preferencesHandle,
      classes: classesHandle,
      lessons: lessonsHandle,
    }),
  });
})();
