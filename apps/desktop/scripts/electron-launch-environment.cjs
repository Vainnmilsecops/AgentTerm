/* global module */
'use strict';

function createElectronLaunchEnvironment(source) {
  const environment = { ...source };
  delete environment.ELECTRON_RUN_AS_NODE;
  return environment;
}

function createElectronSpawnOptions(source) {
  return Object.freeze({
    env: createElectronLaunchEnvironment(source),
    windowsHide: false,
  });
}

module.exports = Object.freeze({
  createElectronLaunchEnvironment,
  createElectronSpawnOptions,
});
