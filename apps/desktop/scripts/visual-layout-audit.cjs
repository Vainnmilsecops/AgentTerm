/* global __dirname, clearTimeout, process, require, setTimeout */
/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';

const { existsSync, mkdirSync, mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const { app, BrowserWindow } = require('electron');

const {
  assessLayoutMeasurement,
  assessTerminalResizeRange,
} = require('./visual-layout-audit-lib.cjs');

const VIEWPORTS = Object.freeze([
  Object.freeze({ height: 1000, width: 1600 }),
  Object.freeze({ height: 800, width: 1120 }),
  Object.freeze({ height: 640, width: 760 }),
  Object.freeze({ height: 480, width: 520 }),
]);
const MAXIMUM_TAB_STEPS = 80;
const RENDER_TIMEOUT_MS = 10_000;
const RENDER_STABILITY_MS = 300;

const outputDirectory = mkdtempSync(join(tmpdir(), 'agentterm-layout-audit-'));
const rendererPath = resolve(__dirname, '..', 'dist', 'renderer', 'index.html');
const preloadPath = resolve(__dirname, 'visual-layout-fixture-preload.cjs');
const progressPath = join(outputDirectory, 'layout-audit-progress.log');
const reportPath = join(outputDirectory, 'layout-audit.json');

app.on('window-all-closed', () => {
  // The audit owns process exit after every requested viewport has been measured.
});

void app
  .whenReady()
  .then(runAudit)
  .then((report) => {
    writeReport(report);
    exitAudit(report.passed ? 0 : 1);
  })
  .catch((error) => {
    const report = Object.freeze({
      error: safeErrorMessage(error),
      generatedAt: new Date().toISOString(),
      outputDirectory,
      passed: false,
      reportPath,
      viewports: Object.freeze([]),
    });
    writeReport(report);
    exitAudit(2);
  });

async function runAudit() {
  traceAudit('app-ready');
  if (!existsSync(rendererPath)) {
    throw new Error('Built desktop renderer was not found. Run the desktop build first.');
  }
  if (!existsSync(preloadPath)) {
    throw new Error('Visual audit fixture preload was not found.');
  }

  mkdirSync(join(outputDirectory, 'electron-user-data'), { recursive: true });
  const viewportResults = [];
  for (const viewport of VIEWPORTS) {
    viewportResults.push(await auditViewport(viewport));
  }
  const breakpointFocus = await auditBreakpointFocusContracts();
  const interactiveContracts = await auditInteractiveContracts();
  const passed =
    viewportResults.every(({ violations }) => violations.length === 0) &&
    breakpointFocus.violations.length === 0 &&
    interactiveContracts.violations.length === 0;
  return Object.freeze({
    breakpointFocus,
    generatedAt: new Date().toISOString(),
    interactiveContracts,
    outputDirectory,
    passed,
    reportPath,
    viewports: Object.freeze(viewportResults),
  });
}

async function auditBreakpointFocusContracts() {
  traceAudit('breakpoint-focus-start');
  const desktopViewport = Object.freeze({ height: 900, width: 1600 });
  const narrowViewport = Object.freeze({ height: 480, width: 520 });
  const inspectorViewport = Object.freeze({ height: 800, width: 1120 });
  const window = createAuditWindow(desktopViewport);
  try {
    await prepareAuditWindow(window);
    window.showInactive();
    window.webContents.invalidate();
    await delay(100);

    await window.webContents.executeJavaScript(
      `document.querySelector('.project-option')?.focus()`,
      true,
    );
    window.setContentSize(narrowViewport.width, narrowViewport.height, false);
    await waitForViewportSize(window.webContents, narrowViewport);
    const navigatorFocusPreserved = await waitForActiveElementMatches(
      window.webContents,
      '#workspace-sidebar, .workspace-sidebar *',
    );
    const navigatorStayedOpen = await waitForSelectorState(
      window.webContents,
      '.workspace-sidebar:not([hidden])',
      true,
    );
    sendEscape(window.webContents);
    await waitForSelectorState(window.webContents, '.workspace-sidebar:not([hidden])', false);

    window.setContentSize(desktopViewport.width, desktopViewport.height, false);
    await waitForViewportSize(window.webContents, desktopViewport);
    await settleRenderer(window.webContents);
    await window.webContents.executeJavaScript(
      `document.querySelector('.task-inspector summary')?.focus()`,
      true,
    );
    window.setContentSize(inspectorViewport.width, inspectorViewport.height, false);
    await waitForViewportSize(window.webContents, inspectorViewport);
    const inspectorFocusPreserved = await waitForActiveElementMatches(
      window.webContents,
      '.task-inspector, .task-inspector *',
    );
    const inspectorStayedOpen = await waitForSelectorState(
      window.webContents,
      '.task-inspector[data-open="true"]',
      true,
    );
    const state = Object.freeze({
      inspectorFocusPreserved,
      inspectorStayedOpen,
      navigatorFocusPreserved,
      navigatorStayedOpen,
    });
    const violations = [];
    if (!navigatorFocusPreserved || !navigatorStayedOpen) {
      violations.push(
        auditViolation(
          'NAVIGATOR_BREAKPOINT_FOCUS_LOST',
          'Entering the narrow breakpoint while focus is in the Project navigator must keep that drawer and focus visible.',
          [JSON.stringify(state)],
        ),
      );
    }
    if (!inspectorFocusPreserved || !inspectorStayedOpen) {
      violations.push(
        auditViolation(
          'INSPECTOR_BREAKPOINT_FOCUS_LOST',
          'Entering the compact breakpoint while focus is in the Task inspector must keep that drawer and focus visible.',
          [JSON.stringify(state)],
        ),
      );
    }
    return Object.freeze({ ...state, violations: Object.freeze(violations) });
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}

async function auditViewport(viewport) {
  traceAudit(`viewport-${String(viewport.width)}x${String(viewport.height)}-start`);
  const window = createAuditWindow(viewport);

  try {
    await prepareAuditWindow(window);
    traceAudit(`viewport-${String(viewport.width)}x${String(viewport.height)}-prepared`);

    const screenshotPath = join(
      outputDirectory,
      `workspace-${String(viewport.width)}x${String(viewport.height)}.png`,
    );
    const screenshot = await captureSettledPage(window);
    writeFileSync(screenshotPath, screenshot.toPNG());
    traceAudit(`viewport-${String(viewport.width)}x${String(viewport.height)}-captured`);

    const measurement = await measureLayout(window.webContents);
    const focusAudit = await auditTabFocus(window.webContents);
    traceAudit(`viewport-${String(viewport.width)}x${String(viewport.height)}-focused`);
    const completeMeasurement = Object.freeze({ ...measurement, focusAudit });
    const violations = assessLayoutMeasurement(completeMeasurement);
    return Object.freeze({
      measurement: completeMeasurement,
      screenshotPath,
      violations: Object.freeze(violations),
      viewport,
    });
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}

async function auditInteractiveContracts() {
  traceAudit('interactive-start');
  const initialViewport = Object.freeze({ height: 900, width: 1600 });
  const resizedViewport = Object.freeze({ height: 480, width: 520 });
  const window = createAuditWindow(initialViewport);

  try {
    await prepareAuditWindow(window);
    traceAudit('interactive-prepared');
    window.showInactive();
    window.webContents.invalidate();
    await delay(100);
    const terminalProjectNavigation = await auditTerminalProjectNavigation(window.webContents);
    traceAudit('interactive-project-navigation-audited');
    const newTaskDialogFocus = await auditNewTaskDialogFocus(window.webContents);
    traceAudit('interactive-dialog-audited');

    window.setContentSize(resizedViewport.width, resizedViewport.height, false);
    await waitForViewportSize(window.webContents, resizedViewport);
    await settleRenderer(window.webContents);
    traceAudit('interactive-resized');
    const responsiveDrawerFocus = await auditResponsiveDrawerFocus(window.webContents);
    traceAudit('interactive-drawers-audited');

    const screenshotPath = join(outputDirectory, 'workspace-dynamic-1600x900-to-520x480.png');
    const screenshot = await captureSettledPage(window);
    writeFileSync(screenshotPath, screenshot.toPNG());

    const measurement = await measureLayout(window.webContents);
    const focusAudit = await auditTabFocus(window.webContents);
    const completeMeasurement = Object.freeze({ ...measurement, focusAudit });
    const terminalResizeRange = await measureTerminalResizeRange(window.webContents);
    const violations = [
      ...assessLayoutMeasurement(completeMeasurement),
      ...assessTerminalResizeRange(terminalResizeRange),
      ...newTaskDialogFocus.violations,
      ...responsiveDrawerFocus.violations,
      ...terminalProjectNavigation.violations,
    ];
    return Object.freeze({
      from: initialViewport,
      measurement: completeMeasurement,
      newTaskDialogFocus,
      responsiveDrawerFocus,
      screenshotPath,
      terminalProjectNavigation,
      terminalResizeRange,
      to: resizedViewport,
      violations: Object.freeze(violations),
    });
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}

async function auditTerminalProjectNavigation(webContents) {
  const prepared = await webContents.executeJavaScript(
    `(() => {
      const terminal = document.querySelector('[data-terminal-pane-id]');
      const projectButtons = document.querySelectorAll('.project-option');
      const emptyProjectButton = projectButtons.item(1);
      if (!(terminal instanceof HTMLElement) || !(emptyProjectButton instanceof HTMLElement)) {
        return false;
      }
      window.__agenttermAuditTerminal = terminal;
      emptyProjectButton.click();
      return true;
    })()`,
    true,
  );
  const emptyProjectOpened =
    prepared === true &&
    (await waitForPageCondition(
      webContents,
      `document.querySelector('.workspace-message h1')?.textContent?.includes('Empty Project') === true`,
    ));
  const terminalPreserved = await webContents.executeJavaScript(
    `window.__agenttermAuditTerminal instanceof HTMLElement && window.__agenttermAuditTerminal.isConnected`,
    true,
  );
  await webContents.executeJavaScript(
    `document.querySelectorAll('.project-option').item(0)?.click()`,
    true,
  );
  const boardRestored = await waitForPageCondition(
    webContents,
    `document.querySelector('.project-board[aria-label="Project board"]') !== null`,
  );
  const violations =
    emptyProjectOpened && terminalPreserved && boardRestored
      ? []
      : [
          auditViolation(
            'TERMINAL_UNMOUNTED_DURING_PROJECT_NAVIGATION',
            'Navigating to an empty Project must preserve the mounted Agent Console and its scrollback.',
            [JSON.stringify({ boardRestored, emptyProjectOpened, terminalPreserved })],
          ),
        ];
  return Object.freeze({
    boardRestored,
    emptyProjectOpened,
    terminalPreserved,
    violations: Object.freeze(violations),
  });
}

async function waitForPageCondition(webContents, expression) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await webContents.executeJavaScript(expression, true)) return true;
    await delay(25);
  }
  return false;
}

async function auditResponsiveDrawerFocus(webContents) {
  const navigatorOpened = await activateSurface(
    webContents,
    '[data-navigator-toggle]',
    '.workspace-sidebar:not([hidden])',
  );
  const navigatorFocused = await waitForActiveElementMatches(
    webContents,
    '#workspace-sidebar, .workspace-sidebar *',
  );
  const navigatorFocusContained = await auditTabContainment(webContents, '#workspace-sidebar', 8);
  const backdropFocused = await webContents.executeJavaScript(
    `(() => {
      const backdrop = document.querySelector('.workspace-sidebar-backdrop');
      if (!(backdrop instanceof HTMLElement)) return false;
      backdrop.focus();
      return document.activeElement === backdrop;
    })()`,
    true,
  );
  sendEscape(webContents);
  const navigatorClosed = await waitForSelectorState(
    webContents,
    '.workspace-sidebar:not([hidden])',
    false,
  );
  const navigatorFocusRestored = await waitForActiveElementMatches(
    webContents,
    '[data-navigator-toggle]',
  );
  if (!navigatorClosed) {
    await webContents.executeJavaScript(
      `document.querySelector('[data-navigator-toggle]')?.click()`,
      true,
    );
  }

  const inspectorOpened = await activateSurface(
    webContents,
    '.project-board-header__inspector-toggle',
    '.task-inspector[data-open="true"]',
  );
  const inspectorFocused = await waitForActiveElementMatches(
    webContents,
    '.task-inspector, .task-inspector *',
  );
  sendEscape(webContents);
  const inspectorClosed = await waitForSelectorState(
    webContents,
    '.task-inspector[data-open="true"]',
    false,
  );
  const inspectorFocusRestored = await waitForActiveElementMatches(
    webContents,
    '.project-board-header__inspector-toggle',
  );
  if (!inspectorClosed) {
    await webContents.executeJavaScript(
      `document.querySelector('.task-inspector__close')?.click()`,
      true,
    );
  }

  const state = Object.freeze({
    inspectorClosed,
    inspectorFocusRestored,
    inspectorFocused,
    inspectorOpened,
    navigatorClosed,
    navigatorFocusContained,
    navigatorFocusRestored,
    navigatorFocused,
    navigatorOpened,
    backdropFocused,
  });
  const violations = [];
  if (
    !navigatorOpened ||
    !navigatorFocused ||
    !navigatorFocusContained ||
    !backdropFocused ||
    !navigatorClosed ||
    !navigatorFocusRestored
  ) {
    violations.push(
      auditViolation(
        'PROJECT_NAVIGATOR_FOCUS_CONTRACT_FAILED',
        'The compact Project navigator must contain Tab focus, close on Escape from its backdrop, and restore focus to its trigger.',
        [JSON.stringify(state)],
      ),
    );
  }
  if (!inspectorOpened || !inspectorFocused || !inspectorClosed || !inspectorFocusRestored) {
    violations.push(
      auditViolation(
        'TASK_INSPECTOR_FOCUS_CONTRACT_FAILED',
        'The compact Task inspector must receive focus when opened, close on Escape, and restore focus to its trigger.',
        [JSON.stringify(state)],
      ),
    );
  }
  return Object.freeze({ ...state, violations: Object.freeze(violations) });
}

async function auditTabContainment(webContents, containerSelector, steps) {
  for (let index = 0; index < steps; index += 1) {
    webContents.sendInputEvent({ keyCode: 'TAB', type: 'keyDown' });
    webContents.sendInputEvent({ keyCode: 'TAB', type: 'keyUp' });
    await delay(20);
    const contained = await webContents.executeJavaScript(
      `(() => {
        const container = document.querySelector(${JSON.stringify(containerSelector)});
        return container !== null && container.contains(document.activeElement);
      })()`,
      true,
    );
    if (!contained) return false;
  }
  webContents.sendInputEvent({ keyCode: 'TAB', modifiers: ['shift'], type: 'keyDown' });
  webContents.sendInputEvent({ keyCode: 'TAB', modifiers: ['shift'], type: 'keyUp' });
  await delay(20);
  return webContents.executeJavaScript(
    `(() => {
      const container = document.querySelector(${JSON.stringify(containerSelector)});
      return container !== null && container.contains(document.activeElement);
    })()`,
    true,
  );
}

async function activateSurface(webContents, triggerSelector, surfaceSelector) {
  const activated = await webContents.executeJavaScript(
    `(() => {
      const trigger = document.querySelector(${JSON.stringify(triggerSelector)});
      if (!(trigger instanceof HTMLElement)) return false;
      trigger.focus();
      trigger.click();
      return true;
    })()`,
    true,
  );
  if (activated !== true) return false;
  return waitForSelectorState(webContents, surfaceSelector, true);
}

async function activeElementMatches(webContents, selector) {
  return webContents.executeJavaScript(
    `document.activeElement instanceof HTMLElement && document.activeElement.matches(${JSON.stringify(selector)})`,
    true,
  );
}

async function waitForActiveElementMatches(webContents, selector) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await activeElementMatches(webContents, selector)) return true;
    await delay(25);
  }
  return false;
}

async function waitForSelectorState(webContents, selector, expectedPresent) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const present = await webContents.executeJavaScript(
      `document.querySelector(${JSON.stringify(selector)}) !== null`,
      true,
    );
    if (present === expectedPresent) return true;
    await delay(25);
  }
  return false;
}

function sendEscape(webContents) {
  webContents.focus();
  webContents.sendInputEvent({ keyCode: 'ESCAPE', type: 'keyDown' });
  webContents.sendInputEvent({ keyCode: 'ESCAPE', type: 'keyUp' });
}

function createAuditWindow(viewport) {
  const window = new BrowserWindow({
    autoHideMenuBar: true,
    backgroundColor: '#0d1117',
    frame: false,
    height: viewport.height,
    opacity: 0,
    show: false,
    skipTaskbar: true,
    title: 'AgentTerm Visual Layout Audit',
    useContentSize: true,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'agentterm-visual-layout-audit',
      preload: preloadPath,
      sandbox: true,
      spellcheck: false,
    },
    width: viewport.width,
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      process.stderr.write(
        `AgentTerm visual audit load failure: code=${String(errorCode)} description=${errorDescription} main=${String(isMainFrame)} url=${validatedUrl}\n`,
      );
    },
  );
  window.webContents.on('preload-error', (_event, failedPreloadPath, error) => {
    process.stderr.write(
      `AgentTerm visual audit preload failure: ${failedPreloadPath} ${safeErrorMessage(error)}\n`,
    );
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  return window;
}

async function captureSettledPage(window) {
  await waitForRenderer(window.webContents);
  window.showInactive();
  window.webContents.invalidate();
  await delay(100);
  const screenshot = await window.webContents.capturePage();
  window.hide();
  return screenshot;
}

async function prepareAuditWindow(window) {
  await loadRenderer(window);
  traceAudit('window-loaded');
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.setZoomFactor(1);
  await waitForRenderer(window.webContents);
  traceAudit('workspace-ready');
  await settleRenderer(window.webContents);
  traceAudit('renderer-settled');
}

async function loadRenderer(window) {
  const { webContents } = window;
  await new Promise((resolveLoad, rejectLoad) => {
    let loadAttemptError;
    const timeout = setTimeout(() => {
      cleanup();
      rejectLoad(
        loadAttemptError ?? new Error('Desktop renderer did not finish its initial file load.'),
      );
    }, RENDER_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timeout);
      webContents.removeListener('did-finish-load', handleFinished);
      webContents.removeListener('did-fail-load', handleFailed);
    };
    const handleFinished = () => {
      cleanup();
      resolveLoad();
    };
    const handleFailed = (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (!isMainFrame) return;
      cleanup();
      rejectLoad(
        new Error(
          `Desktop renderer load failed (${String(errorCode)} ${errorDescription}) for ${validatedUrl}.`,
        ),
      );
    };
    webContents.once('did-finish-load', handleFinished);
    webContents.on('did-fail-load', handleFailed);
    void window.loadFile(rendererPath).catch((error) => {
      loadAttemptError = error;
    });
  });
}

async function waitForRenderer(webContents) {
  const deadline = Date.now() + RENDER_TIMEOUT_MS;
  let readySince;
  while (Date.now() < deadline) {
    const ready = await webContents.executeJavaScript(
      `(() => {
        const root = document.getElementById('root');
        const main = document.querySelector('#workspace-main, [data-workspace-main], .workspace-main');
        const board = document.querySelector('.project-board[aria-label="Project board"]');
        const consoleDock = document.querySelector(
          '.workspace-console-dock[aria-label="Agent Console"]'
        );
        const boardHeading = [...document.querySelectorAll('h1')].find(
          (heading) => heading.textContent?.trim() === 'Project Board'
        );
        const boardColumns = board?.querySelectorAll('.project-board__column').length ?? 0;
        return root !== null &&
          root.childElementCount > 0 &&
          main !== null &&
          board !== null &&
          consoleDock !== null &&
          boardHeading !== undefined &&
          boardColumns === 5;
      })()`,
      true,
    );
    if (ready === true) {
      readySince ??= Date.now();
      if (Date.now() - readySince >= RENDER_STABILITY_MS) return;
    } else {
      readySince = undefined;
    }
    await delay(50);
  }
  throw new Error('Desktop renderer did not maintain a ready workspace before the audit timeout.');
}

async function settleRenderer(webContents) {
  await webContents.executeJavaScript(
    `(() => {
      if (document.getElementById('agentterm-visual-audit-motion') === null) {
        const style = document.createElement('style');
        style.id = 'agentterm-visual-audit-motion';
        style.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;}';
        document.head.append(style);
      }
      window.scrollTo(0, 0);
      for (const element of document.querySelectorAll('[class*="scroll"], .project-board, .task-inspector')) {
        element.scrollTop = 0;
        element.scrollLeft = 0;
      }
    })()`,
    true,
  );
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const fontsLoaded = await webContents.executeJavaScript(
      `document.fonts === undefined || document.fonts.status === 'loaded'`,
      true,
    );
    if (fontsLoaded === true) {
      await delay(50);
      return;
    }
    await delay(25);
  }
  throw new Error('Desktop renderer fonts did not settle before the visual audit timeout.');
}

async function waitForViewportSize(webContents, viewport) {
  const deadline = Date.now() + RENDER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const sizeMatches = await webContents.executeJavaScript(
      `window.innerWidth === ${String(viewport.width)} && window.innerHeight === ${String(viewport.height)}`,
      true,
    );
    if (sizeMatches === true) return;
    await delay(25);
  }
  throw new Error('Electron content viewport did not reach the requested dynamic resize.');
}

async function measureLayout(webContents) {
  return webContents.executeJavaScript(
    `(() => {
      const selectorSets = {
        topbar: ['[data-workspace-topbar]', '.workspace-topbar', '[role="banner"]'],
        main: ['#workspace-main', '[data-workspace-main]', '.workspace-main', 'main[aria-label]', 'main'],
        console: [
          '[data-agent-console]',
          '.workspace-console-dock',
          '[aria-label="Agent Console"]',
          '[aria-label="Workspace terminals"]'
        ]
      };
      const isVisible = (element) => {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        for (let node = element; node instanceof Element; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            Number.parseFloat(style.opacity || '1') <= 0.01 ||
            node.hasAttribute('hidden') ||
            node.getAttribute('aria-hidden') === 'true'
          ) return false;
        }
        return true;
      };
      const region = (selectors) => {
        for (const selector of selectors) {
          const element = document.querySelector(selector);
          if (element === null) continue;
          const source = element.getBoundingClientRect();
          const rect = {
            bottom: source.bottom,
            height: source.height,
            left: source.left,
            right: source.right,
            top: source.top,
            width: source.width
          };
          return { exists: true, rect, selector, visible: isVisible(element) };
        }
        return { exists: false, selector: undefined, visible: false };
      };
      const rectOf = (element) => {
        if (!(element instanceof Element)) return undefined;
        const source = element.getBoundingClientRect();
        return {
          bottom: source.bottom,
          height: source.height,
          left: source.left,
          right: source.right,
          top: source.top,
          width: source.width
        };
      };
      const emptyCard = document.querySelector('.terminal-panel__empty-card');
      const terminalPanel = emptyCard?.closest('.terminal-panel');
      return {
        documentScrollWidth: Math.max(
          document.documentElement.scrollWidth,
          document.body?.scrollWidth ?? 0
        ),
        regions: {
          console: region(selectorSets.console),
          main: region(selectorSets.main),
          topbar: region(selectorSets.topbar)
        },
        terminalEmptyState: emptyCard === null
          ? { exists: false }
          : {
              card: rectOf(emptyCard),
              exists: true,
              header: rectOf(terminalPanel?.querySelector('.terminal-panel__header')),
              viewport: rectOf(terminalPanel?.querySelector('.terminal-panel__viewport'))
            },
        viewport: { height: window.innerHeight, width: window.innerWidth }
      };
    })()`,
    true,
  );
}

async function auditTabFocus(webContents) {
  const candidateCount = await webContents.executeJavaScript(
    `(() => {
      document.activeElement instanceof HTMLElement && document.activeElement.blur();
      window.scrollTo(0, 0);
      return [...document.querySelectorAll(
        'a[href], button, input, select, textarea, summary, [tabindex]'
      )].filter((element) =>
        !element.hasAttribute('disabled') &&
        element.getAttribute('tabindex') !== '-1' &&
        !element.closest('[inert], [hidden]')
      ).length;
    })()`,
    true,
  );
  const maximumSteps = Math.min(MAXIMUM_TAB_STEPS, Number(candidateCount) + 3);
  const visited = [];
  const hiddenReachable = [];
  const seen = new Set();
  webContents.focus();

  for (let index = 0; index < maximumSteps; index += 1) {
    webContents.sendInputEvent({ keyCode: 'TAB', type: 'keyDown' });
    webContents.sendInputEvent({ keyCode: 'TAB', type: 'keyUp' });
    await delay(20);
    const state = await inspectActiveElement(webContents);
    if (state === undefined || state.key === 'document-body') continue;
    if (seen.has(state.key)) break;
    seen.add(state.key);
    visited.push(state);
    if (!state.visible) {
      hiddenReachable.push(Object.freeze({ descriptor: state.descriptor, label: state.label }));
    }
  }

  return Object.freeze({
    hiddenReachable: Object.freeze(hiddenReachable),
    visited: visited.length,
  });
}

async function inspectActiveElement(webContents) {
  return webContents.executeJavaScript(
    `(() => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || active === document.body) {
        return { descriptor: 'body', key: 'document-body', label: '', visible: true };
      }
      const allElements = [...document.querySelectorAll('*')];
      const ordinal = allElements.indexOf(active);
      const className = typeof active.className === 'string'
        ? active.className.trim().split(/\\s+/u).filter(Boolean).slice(0, 2).join('.')
        : '';
      const descriptor = active.tagName.toLowerCase() +
        (active.id ? '#' + active.id : '') +
        (className ? '.' + className : '');
      const proxy = active.matches('.xterm-helper-textarea')
        ? active.closest('.terminal-panel') ?? active
        : active;
      const rect = proxy.getBoundingClientRect();
      let visible = rect.width > 0 && rect.height > 0 &&
        rect.right > 0 && rect.bottom > 0 &&
        rect.left < window.innerWidth && rect.top < window.innerHeight;
      for (let node = proxy; visible && node instanceof Element; node = node.parentElement) {
        const style = getComputedStyle(node);
        visible =
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number.parseFloat(style.opacity || '1') > 0.01 &&
          !node.hasAttribute('hidden') &&
          node.getAttribute('aria-hidden') !== 'true';
      }
      const label = (
        active.getAttribute('aria-label') ||
        active.getAttribute('title') ||
        active.textContent ||
        active.getAttribute('placeholder') ||
        ''
      ).trim().replace(/\\s+/gu, ' ').slice(0, 120);
      return { descriptor, key: descriptor + ':' + String(ordinal), label, visible };
    })()`,
    true,
  );
}

async function measureTerminalResizeRange(webContents) {
  return webContents.executeJavaScript(
    `(() => {
      const selectors = [
        '[aria-label="Resize terminal height"][role="separator"]',
        '[aria-label="Resize Agent console"][role="separator"]',
        '.terminal-resize-handle[role="separator"]',
        '[data-terminal-resize][role="separator"]'
      ];
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element === null) continue;
        const numberAttribute = (name) => {
          const raw = element.getAttribute(name);
          return raw === null ? undefined : Number(raw);
        };
        return {
          exists: true,
          maximum: numberAttribute('aria-valuemax'),
          minimum: numberAttribute('aria-valuemin'),
          selector,
          value: numberAttribute('aria-valuenow')
        };
      }
      return { exists: false };
    })()`,
    true,
  );
}

async function auditNewTaskDialogFocus(webContents) {
  const triggerFound = await webContents.executeJavaScript(
    `(() => {
      const trigger = document.querySelector('[data-new-task-trigger], button[aria-label="New Task"]');
      if (!(trigger instanceof HTMLElement)) return false;
      trigger.click();
      return true;
    })()`,
    true,
  );
  if (triggerFound !== true) {
    return dialogFocusResult(
      false,
      0,
      [],
      [auditViolation('NEW_TASK_TRIGGER_MISSING', 'The New Task trigger was not found.')],
    );
  }

  const dialogOpened = await waitForDialog(webContents, true);
  if (!dialogOpened) {
    return dialogFocusResult(
      false,
      0,
      [],
      [
        auditViolation(
          'NEW_TASK_DIALOG_MISSING',
          'Activating New Task did not open an aria-modal dialog.',
        ),
      ],
    );
  }

  await webContents.executeJavaScript(
    `(() => {
      const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
      const first = dialog?.querySelector(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (first instanceof HTMLElement) first.focus();
    })()`,
    true,
  );

  const focusableCount = await webContents.executeJavaScript(
    `(() => {
      const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
      if (dialog === null) return 0;
      return [...dialog.querySelectorAll('button, input, select, textarea, [tabindex]')].filter(
        (element) => !element.hasAttribute('disabled') && element.getAttribute('tabindex') !== '-1'
      ).length;
    })()`,
    true,
  );
  const escapedFocus = [];
  const steps = Math.min(24, Math.max(2, Number(focusableCount) + 2));
  for (let index = 0; index < steps; index += 1) {
    webContents.sendInputEvent({ keyCode: 'TAB', type: 'keyDown' });
    webContents.sendInputEvent({ keyCode: 'TAB', type: 'keyUp' });
    await delay(15);
    const state = await inspectDialogFocus(webContents);
    if (!state.inside) escapedFocus.push(state.descriptor);
  }
  webContents.sendInputEvent({ keyCode: 'TAB', modifiers: ['shift'], type: 'keyDown' });
  webContents.sendInputEvent({ keyCode: 'TAB', modifiers: ['shift'], type: 'keyUp' });
  await delay(15);
  const reverseState = await inspectDialogFocus(webContents);
  if (!reverseState.inside) escapedFocus.push(reverseState.descriptor);

  webContents.sendInputEvent({ keyCode: 'ESCAPE', type: 'keyDown' });
  webContents.sendInputEvent({ keyCode: 'ESCAPE', type: 'keyUp' });
  await waitForDialog(webContents, false);

  const violations =
    escapedFocus.length === 0
      ? []
      : [
          auditViolation(
            'NEW_TASK_DIALOG_FOCUS_ESCAPED',
            `Focus escaped the aria-modal New Task dialog ${String(escapedFocus.length)} time(s).`,
            escapedFocus,
          ),
        ];
  return dialogFocusResult(true, steps + 1, escapedFocus, violations);
}

async function inspectDialogFocus(webContents) {
  return webContents.executeJavaScript(
    `(() => {
      const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) return { descriptor: 'none', inside: false };
      const descriptor = active.tagName.toLowerCase() +
        (active.id ? '#' + active.id : '') +
        (typeof active.className === 'string' && active.className.trim().length > 0
          ? '.' + active.className.trim().split(/\\s+/u).slice(0, 2).join('.')
          : '');
      return { descriptor, inside: dialog !== null && dialog.contains(active) };
    })()`,
    true,
  );
}

async function waitForDialog(webContents, expectedOpen) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const open = await webContents.executeJavaScript(
      `document.querySelector('[role="dialog"][aria-modal="true"]') !== null`,
      true,
    );
    if (open === expectedOpen) return true;
    await delay(25);
  }
  return false;
}

function dialogFocusResult(opened, steps, escapedFocus, violations) {
  return Object.freeze({
    escapedFocus: Object.freeze([...escapedFocus]),
    opened,
    steps,
    violations: Object.freeze(violations),
  });
}

function auditViolation(code, message, details) {
  return Object.freeze({
    code,
    message,
    ...(details === undefined ? {} : { details: Object.freeze([...details]) }),
  });
}

function writeReport(report) {
  const json = `${JSON.stringify(report, undefined, 2)}\n`;
  writeFileSync(reportPath, json, 'utf8');
  process.stdout.write(json);
  process.stdout.write(`AgentTerm visual layout audit report: ${reportPath}\n`);
}

function exitAudit(exitCode) {
  process.exitCode = exitCode;
  app.exit(exitCode);
}

function safeErrorMessage(error) {
  return error instanceof Error && error.message.length > 0
    ? error.message.slice(0, 512)
    : 'Visual layout audit failed unexpectedly.';
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function traceAudit(stage) {
  writeFileSync(progressPath, `${new Date().toISOString()} ${stage}\n`, {
    encoding: 'utf8',
    flag: 'a',
  });
}
