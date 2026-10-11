import type { BrowserContext, Page } from 'playwright';
import { inspectPage } from './browser-runtime';
import { runCapabilityJavaScriptStages } from './javascript-stage-runner';

/** Worker-owned bindings. Only this public catalog enters the model context. */
export function createAuthoringConnectors(options: {
  page: Page;
  startUrl: string;
  createContext: () => Promise<{context: BrowserContext; page: Page}>;
}) {
  return {
    catalog: {
      schemaVersion: 'capability-connectors.v1',
      browser: {driver:'playwright',purpose:'observe-and-debug',origin:new URL(options.startUrl).origin},
      execution: {driver:'sitewake-browser-sdk',kernelVersion:'2',purpose:'candidate-replay',target:'browser-sdk'},
      credentials: 'host-owned-reference-only',
    },
    browser: {
      observe: () => inspectPage(options.page),
      evaluate: (source: string) => options.page.evaluate(source),
    },
    execution: {
      createContext: options.createContext,
      run: runCapabilityJavaScriptStages,
    },
  };
}
export type AuthoringConnectors = ReturnType<typeof createAuthoringConnectors>;
