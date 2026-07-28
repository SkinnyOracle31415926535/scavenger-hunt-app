(() => {
  'use strict';

  const migrationAllowed = preview => Boolean(
    preview
    && preview.writesPerformed === 0
    && preview.remoteCount === 0
    && preview.orphanedCount === 0
  );

  const createRemoteApplyQueue = dependencies => {
    let tail = Promise.resolve();
    return (metadata, operation) => {
      if (!metadata || !['remote', 'migration'].includes(metadata.source)) {
        throw new Error('The sync client requested an invalid remote-write source.');
      }
      const requestedRevision = dependencies.getRevision();
      const task = tail.catch(() => {}).then(async () => {
        await dependencies.whenLocalIdle();
        await dependencies.whenStagingSettled();
        await dependencies.waitForEditorIdle();
        await dependencies.whenLocalIdle();
        await dependencies.whenStagingSettled();
        const currentRevision = dependencies.getRevision();
        if (currentRevision.local !== requestedRevision.local
          || currentRevision.storage !== requestedRevision.storage) {
          throw new Error(
            'A newer local Scavenger Hunt edit was preserved instead of deferred synchronized data.'
          );
        }
        return operation({
          expectedLocalRevision: currentRevision.local,
          expectedStorageRevision: currentRevision.storage,
        });
      });
      tail = task;
      return task;
    };
  };

  window.ScavengerSyncSafety = Object.freeze({
    migrationAllowed,
    createRemoteApplyQueue,
  });
})();
