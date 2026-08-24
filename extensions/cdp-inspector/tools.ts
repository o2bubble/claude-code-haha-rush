import type { ConsoleEntry } from './cdpClient.js';
import { cdp } from './cdpClient.js';

// ── Async mutex for connection safety ─────────────────────────────────────
// Prevents concurrent ensureConnected() calls from racing each other
// when a subagent and the main session both try to use CDP simultaneously.
class Mutex {
  private queue: (() => void)[] = [];
  private locked = false;

  acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.locked = true;
        resolve();
      });
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.locked = false;
    }
  }
}

const connectMutex = new Mutex();

// ── Tool definitions (JSON Schema for MCP) ──────────────────────────────

export function getToolDefinitions() {
  return [
    {
      name: 'cdp_pages',
      description:
        'List all open browser tabs/pages in Chrome/Edge. Returns page ID, URL, and title for each tab.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'cdp_inspect',
      description:
        'Get the real rendered DOM (outerHTML, attributes, class list) for an element matching a CSS selector in the browser page.',
      inputSchema: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS selector or XPath to find the element (e.g. "div.container", ".card", "//button[@aria-label=\'Submit\']", "//div/span[2]")',
          },
          pageId: {
            type: 'string',
            description:
              'Optional. Target page/tab ID from cdp_pages. Uses the current or first page if omitted.',
          },
        },
        required: ['selector'],
      },
    },
    {
      name: 'cdp_styles',
      description:
        'Get the full computed CSS styles for an element matching a CSS selector. Returns all resolved style properties (display, position, colors, fonts, spacing, etc.) — exactly what the browser is rendering.',
      inputSchema: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS selector or XPath to find the element.',
          },
          pageId: {
            type: 'string',
            description: 'Optional. Target page/tab ID. Uses current or first page if omitted.',
          },
        },
        required: ['selector'],
      },
    },
    {
      name: 'cdp_box',
      description:
        'Get the box model (content, padding, border, margin) and screen position for an element. Returns pixel values as rendered by the browser.',
      inputSchema: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS selector or XPath to find the element.',
          },
          pageId: {
            type: 'string',
            description: 'Optional. Target page/tab ID. Uses current or first page if omitted.',
          },
        },
        required: ['selector'],
      },
    },
    {
      name: 'cdp_console',
      description:
        'Read recent console logs from the browser page. Includes console.log/warn/error/info/debug calls, uncaught exceptions, and network/deprecation warnings.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description:
              'Max number of log entries to return (default: 50). Most recent entries first.',
          },
          pageId: {
            type: 'string',
            description: 'Optional. Target page/tab ID. Uses current or first page if omitted.',
          },
        },
      },
    },
    {
      name: 'cdp_click',
      description:
        'Click an element in the browser page matching a CSS selector or XPath. Uses CDP Input.dispatchMouseEvent for realistic click behavior.',
      inputSchema: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS selector or XPath to find the element to click (e.g. "div.container", ".btn", "//button[@aria-label=\'Submit\']")',
          },
          pageId: {
            type: 'string',
            description: 'Optional. Target page/tab ID from cdp_pages. Uses the current or first page if omitted.',
          },
        },
        required: ['selector'],
      },
    },
    {
      name: 'cdp_type',
      description:
        'Type text into an input or contenteditable element matching the CSS selector. Uses CDP Runtime.evaluate to set the value and dispatch input/change events.',
      inputSchema: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS selector or XPath to find the input element.',
          },
          text: {
            type: 'string',
            description: 'The text to type into the element.',
          },
          pageId: {
            type: 'string',
            description: 'Optional. Target page/tab ID.',
          },
        },
        required: ['selector', 'text'],
      },
    },
    {
      name: 'cdp_scroll',
      description:
        'Scroll to bring an element matching the CSS selector into view. Uses element.scrollIntoView().',
      inputSchema: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS selector or XPath to find the element to scroll to.',
          },
          pageId: {
            type: 'string',
            description: 'Optional. Target page/tab ID.',
          },
        },
        required: ['selector'],
      },
    },
    {
      name: 'cdp_select',
      description:
        'Select an option in a <select> dropdown element. Provide the option\'s value (or visible text) to select. Uses Runtime.evaluate to set the value and dispatch a change event.',
      inputSchema: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS selector or XPath to find the <select> element.',
          },
          value: {
            type: 'string',
            description: 'The option value to select (optional if text is provided).',
          },
          text: {
            type: 'string',
            description: 'The visible text of the option to select (optional if value is provided).',
          },
          pageId: {
            type: 'string',
            description: 'Optional. Target page/tab ID.',
          },
        },
        required: ['selector'],
      },
    },
    {
      name: 'cdp_hover',
      description:
        'Move the mouse over an element matching the CSS selector to trigger CSS :hover styles and hover-related events.',
      inputSchema: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS selector or XPath to find the element to hover over.',
          },
          pageId: {
            type: 'string',
            description: 'Optional. Target page/tab ID.',
          },
        },
        required: ['selector'],
      },
    },
    {
      name: 'cdp_wait',
      description:
        'Wait up to the specified timeout for an element matching the CSS selector to appear in the DOM. Polls every 200ms. Useful before interacting with dynamically-loaded content.',
      inputSchema: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS selector or XPath to find the element to wait for.',
          },
          timeout: {
            type: 'number',
            description: 'Maximum wait time in milliseconds (default: 5000).',
          },
          pageId: {
            type: 'string',
            description: 'Optional. Target page/tab ID.',
          },
        },
        required: ['selector'],
      },
    },
    {
      name: 'cdp_focus',
      description:
        'Focus an element matching the CSS selector and dispatch focus events. Useful for revealing focus-specific UI like tooltips, dropdowns, or validation styles.',
      inputSchema: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS selector or XPath to find the element to focus.',
          },
          pageId: {
            type: 'string',
            description: 'Optional. Target page/tab ID.',
          },
        },
        required: ['selector'],
      },
    },
    {
      name: 'cdp_reload',
      description:
        'Reload or hard-reload the current browser page (F5 vs Ctrl+F5). Optionally preserve the console log buffer.',
      inputSchema: {
        type: 'object',
        properties: {
          hard: {
            type: 'boolean',
            description: 'Hard reload, bypass cache (default: false, like F5). Set true for Ctrl+F5 behavior.',
          },
          preserveLog: {
            type: 'boolean',
            description: 'Preserve console log across reload (default: false).',
          },
          pageId: {
            type: 'string',
            description: 'Optional. Target page/tab ID.',
          },
        },
      },
    },
    {
      name: 'cdp_network',
      description:
        'Get recent network request/response logs from the browser page. Returns URLs, methods, status codes, and timing for each request.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Max number of entries to return (default: 20). Most recent entries first.',
          },
          pageId: {
            type: 'string',
            description: 'Optional. Target page/tab ID.',
          },
        },
      },
    },
    {
      name: 'cdp_drag',
      description:
        'Drag an element from its current position and drop at a target location. Simulates mousedown → mousemove → mouseup for HTML5 drag-and-drop or free-position dragging.',
      inputSchema: {
        type: 'object',
        properties: {
          sourceSelector: {
            type: 'string',
            description: 'CSS selector for the element to drag.',
          },
          targetSelector: {
            type: 'string',
            description: 'CSS selector for the drop target element. Mutually exclusive with x/y.',
          },
          x: {
            type: 'number',
            description: 'Absolute X coordinate to drop at. Use with y. Ignored if targetSelector is set.',
          },
          y: {
            type: 'number',
            description: 'Absolute Y coordinate to drop at. Use with x. Ignored if targetSelector is set.',
          },
          dx: {
            type: 'number',
            description: 'Relative X offset from source center to drag. Use with dy. Ignored if targetSelector or x/y is set.',
          },
          dy: {
            type: 'number',
            description: 'Relative Y offset from source center to drag. Use with dx. Ignored if targetSelector or x/y is set.',
          },
          steps: {
            type: 'number',
            description: 'Number of intermediate mousemove steps (default: 10). More = smoother.',
          },
          pageId: {
            type: 'string',
            description: 'Optional. Target page/tab ID.',
          },
        },
        required: ['sourceSelector'],
      },
    },
    {
      name: 'cdp_evaluate',
      description:
        'Execute arbitrary JavaScript in the browser page context and return the result. Use this to query any runtime information: DOM state, framework internals, global variables, etc.',
      inputSchema: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description: 'JavaScript expression to evaluate in the page context.',
          },
          pageId: {
            type: 'string',
            description: 'Optional. Target page/tab ID. Uses current or first page if omitted.',
          },
        },
        required: ['expression'],
      },
    },
  ];
}

// ── Tool dispatch ────────────────────────────────────────────────────────

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  // cdp_pages only uses HTTP fetch — no WebSocket needed
  if (name === 'cdp_pages') {
    return listPages();
  }

  // All other tools need the WebSocket connection.
  // Use a mutex so concurrent calls from subagents + main session
  // don't tear down each other's connection mid-flight.
  await connectMutex.acquire();
  try {
    await ensureConnected(args.pageId as string | undefined);
  } finally {
    connectMutex.release();
  }

  switch (name) {
    case 'cdp_inspect':
      return inspectElement(args.selector as string);
    case 'cdp_styles':
      return getStyles(args.selector as string);
    case 'cdp_box':
      return getBox(args.selector as string);
    case 'cdp_console':
      return getConsole(args.limit as number | undefined);
    case 'cdp_click':
      return clickElement(args.selector as string);
    case 'cdp_evaluate':
      return evaluate(args.expression as string);
    case 'cdp_type':
      return typeText(args.selector as string, args.text as string);
    case 'cdp_scroll':
      return scrollTo(args.selector as string);
    case 'cdp_select':
      return selectOption(args.selector as string, args.value as string | undefined, args.text as string | undefined);
    case 'cdp_hover':
      return hoverElement(args.selector as string);
    case 'cdp_drag':
      return dragElement(
        args.sourceSelector as string,
        args.targetSelector as string | undefined,
        args.x as number | undefined,
        args.y as number | undefined,
        args.dx as number | undefined,
        args.dy as number | undefined,
        args.steps as number | undefined,
      );
    case 'cdp_wait':
      return waitForElement(args.selector as string, args.timeout as number | undefined);
    case 'cdp_focus':
      return focusElement(args.selector as string);
    case 'cdp_reload':
      return reloadPage(args.hard as boolean | undefined, args.preserveLog as boolean | undefined);
    case 'cdp_network':
      return getNetwork(args.limit as number | undefined);
    default:
      return `Unknown tool: ${name}`;
  }
}

// ── Connection helper ────────────────────────────────────────────────────

async function ensureConnected(pageId?: string): Promise<void> {
  if (pageId) {
    // Skip reconnect if already on the requested page
    if (cdp.isConnected() && cdp.currentPageId === pageId) return;
    await cdp.connect(pageId);
  } else if (!cdp.isConnected()) {
    await cdp.connect();
  }
}

// ── Tool implementations ─────────────────────────────────────────────────

async function listPages(): Promise<string> {
  const pages = await cdp.listPages();
  if (pages.length === 0) {
    return 'No open pages found in browser.';
  }

  const lines = pages.map((p, i) => {
    const marker = p.id === cdp.currentPageId ? ' [active]' : '';
    return `${i + 1}. ${p.title || '(untitled)'}\n   ID: ${p.id}\n   URL: ${p.url}${marker}`;
  });

  return `${pages.length} page(s) open:\n\n${lines.join('\n\n')}`;
}

// ── Element helpers ──────────────────────────────────────────────────────

interface CDPQueryResult {
  nodeId: number;
}

interface CDPOuterHTML {
  outerHTML: string;
}

interface CDPAttributes {
  attributes: string[];
}

interface CDPDescribeResult {
  node: {
    nodeId: number;
    nodeType: number;
    nodeName: string;
    localName: string;
    nodeValue: string;
    childNodeCount?: number;
    attributes?: string[];
  };
}

function isXPath(selector: string): boolean {
  return /^\/\/?/.test(selector.trim());
}

async function querySelector(selector: string): Promise<number> {
  if (isXPath(selector)) {
    return querySelectorByXPath(selector);
  }

  // CSS selector path
  const doc = (await cdp.cmd('DOM.getDocument', { depth: -1 })) as { root: { nodeId: number } };

  const result = (await cdp.cmd('DOM.querySelector', {
    nodeId: doc.root.nodeId,
    selector,
  })) as CDPQueryResult;

  if (!result.nodeId || result.nodeId === 0) {
    throw new Error(`No element matching '${selector}' found in the page.`);
  }

  return result.nodeId;
}

async function querySelectorByXPath(xpath: string): Promise<number> {
  // DOM.performSearch supports both XPath and CSS
  const search = (await cdp.cmd('DOM.performSearch', {
    query: xpath,
    includeUserAgentShadowDOM: true,
  })) as { searchId: string; resultCount: number };

  try {
    if (search.resultCount === 0) {
      throw new Error(`No element matching '${xpath}' found in the page.`);
    }

    const results = (await cdp.cmd('DOM.getSearchResults', {
      searchId: search.searchId,
      fromIndex: 0,
      toIndex: 1, // only need the first match
    })) as { nodeIds: number[] };

    if (!results.nodeIds || results.nodeIds.length === 0) {
      throw new Error(`No element matching '${xpath}' found in the page.`);
    }

    return results.nodeIds[0];
  } finally {
    // Always discard search results to free resources
    await cdp.cmd('DOM.discardSearchResults', {
      searchId: search.searchId,
    }).catch(() => {});
  }
}

async function describeNode(nodeId: number): Promise<CDPDescribeResult> {
  return (await cdp.cmd('DOM.describeNode', { nodeId, depth: 0 })) as CDPDescribeResult;
}

async function getOuterHTML(nodeId: number): Promise<string> {
  const result = (await cdp.cmd('DOM.getOuterHTML', { nodeId })) as CDPOuterHTML;
  return result.outerHTML;
}

async function inspectElement(selector: string): Promise<string> {
  const nodeId = await querySelector(selector);
  const [desc, html] = await Promise.all([describeNode(nodeId), getOuterHTML(nodeId)]);

  const node = desc.node;
  const attrs = node.attributes || [];
  const attrStr =
    attrs.length > 0
      ? '\n' + attrs.map((a, i) => (i % 2 === 0 ? `  ${a}="${attrs[i + 1]}"` : '')).filter(Boolean).join('\n')
      : '  (none)';

  const lines = [
    `Element: <${node.localName}>`,
    `  nodeType: ${node.nodeType}`,
    `  nodeId: ${nodeId}`,
    `  childNodeCount: ${node.childNodeCount ?? 'N/A'}`,
    `Attributes:${attrStr}`,
    '',
    '--- Rendered outerHTML ---',
    html.length > 8000 ? html.slice(0, 8000) + '\n... (truncated, use cdp_evaluate for full HTML)' : html,
  ];

  return lines.join('\n');
}

async function getStyles(selector: string): Promise<string> {
  const nodeId = await querySelector(selector);

  const result = (await cdp.cmd('CSS.getComputedStyleForNode', { nodeId })) as {
    computedStyle: Array<{ name: string; value: string }>;
  };

  const styles = result.computedStyle;
  if (!styles || styles.length === 0) {
    return `No computed styles for '${selector}'.`;
  }

  // Group key style categories
  const keyCategories: Record<string, string[]> = {
    Layout: ['display', 'position', 'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'align-content', 'gap', 'grid-template-columns', 'grid-template-rows', 'flex', 'flex-grow', 'flex-shrink', 'flex-basis', 'order'],
    Box: ['width', 'height', 'min-width', 'min-height', 'max-width', 'max-height', 'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'border', 'border-width', 'border-style', 'border-color', 'border-radius', 'box-sizing', 'overflow', 'overflow-x', 'overflow-y'],
    Typography: ['font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-align', 'text-decoration', 'text-transform', 'white-space', 'word-break', 'color'],
    Visual: ['background', 'background-color', 'background-image', 'opacity', 'box-shadow', 'visibility', 'z-index', 'transform', 'transition', 'animation'],
  };

  const styleMap = new Map<string, string>();
  for (const s of styles) {
    styleMap.set(s.name, s.value);
  }

  // Output key properties first, then all properties
  const lines: string[] = [];
  lines.push(`Computed styles for '${selector}' (${styles.length} properties total)\n`);

  for (const [category, props] of Object.entries(keyCategories)) {
    const entries = props.filter((p) => styleMap.has(p));
    if (entries.length === 0) continue;
    lines.push(`--- ${category} ---`);
    for (const prop of props) {
      const val = styleMap.get(prop);
      if (val) lines.push(`  ${prop}: ${val}`);
    }
    lines.push('');
  }

  // Add all remaining properties
  lines.push('--- All properties ---');
  for (const s of styles) {
    lines.push(`  ${s.name}: ${s.value}`);
  }

  return lines.join('\n');
}

async function getBox(selector: string): Promise<string> {
  const nodeId = await querySelector(selector);

  const result = (await cdp.cmd('DOM.getBoxModel', { nodeId })) as {
    model: {
      content: number[];
      padding: number[];
      border: number[];
      margin: number[];
      width: number;
      height: number;
    };
  };

  const m = result.model;
  if (!m) {
    return `No box model available for '${selector}'. The element may be display:none or not in the layout.`;
  }

  // CDP returns quad arrays: [x1,y1, x2,y2, x3,y3, x4,y4] (clockwise from top-left)
  const contentW = m.content[2] - m.content[0];
  const contentH = m.content[7] - m.content[1];
  const padTop = m.padding[1] - m.content[1];
  const padRight = m.content[2] - m.padding[2];
  const padBottom = m.padding[7] - m.content[7];
  const padLeft = m.padding[0] - m.content[0];
  const borderTop = m.border[1] - m.padding[1];
  const borderRight = m.padding[2] - m.border[2];
  const borderBottom = m.border[7] - m.padding[7];
  const borderLeft = m.border[0] - m.padding[0];
  const marginTop = m.margin[1] - m.border[1];
  const marginRight = m.border[2] - m.margin[2];
  const marginBottom = m.margin[7] - m.border[7];
  const marginLeft = m.margin[0] - m.border[0];

  return [
    `Box model for '${selector}':`,
    '',
    `  Content:  ${contentW}px x ${contentH}px`,
    `  Padding:  top=${padTop}  right=${padRight}  bottom=${padBottom}  left=${padLeft}`,
    `  Border:   top=${borderTop}  right=${borderRight}  bottom=${borderBottom}  left=${borderLeft}`,
    `  Margin:   top=${marginTop}  right=${marginRight}  bottom=${marginBottom}  left=${marginLeft}`,
    '',
    `  Position (top-left): (${Math.round(m.content[0])}, ${Math.round(m.content[1])})`,
    `  Total size (margin to margin): ${m.width}px x ${m.height}px`,
  ].join('\n');
}

async function getConsole(limit?: number): Promise<string> {
  const entries = cdp.getConsoleLogs(limit || 50);

  if (entries.length === 0) {
    return 'No console logs collected yet. The page may not have produced any output, or logs were cleared on navigation.';
  }

  const lines = entries.map((e: ConsoleEntry) => {
    const time = new Date(e.timestamp).toISOString().slice(11, 23);
    return `[${time}] [${e.type}] ${e.text}`;
  });

  return `${entries.length} console log(s) (of ${cdp.getConsoleLogs(0).length} total buffered):\n\n${lines.join('\n')}`;
}

// Longer timeout for JS evaluation (async code may take time)
const EVALUATE_TIMEOUT = 60_000;

async function evaluate(expression: string): Promise<string> {
  // Note: awaitPromise is NOT set here — if the expression returns a
  // Promise that never settles, CDP hangs until timeout. The caller
  // should wrap async expressions in a race-with-timeout if needed.
  const result = (await cdp.cmd('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: false,
  }, EVALUATE_TIMEOUT)) as {
    result: {
      type: string;
      value?: unknown;
      description?: string;
    };
    exceptionDetails?: {
      text?: string;
      exception?: { description?: string };
    };
  };

  if (result.exceptionDetails) {
    const errText =
      result.exceptionDetails.text ||
      result.exceptionDetails.exception?.description ||
      'Unknown error';
    return `Evaluation failed: ${errText}`;
  }

  const value = result.result;
  const display =
    value.type === 'object' || value.type === 'function'
      ? JSON.stringify(value.value, null, 2) || value.description || `[${value.type}]`
      : String(value.value ?? value.description ?? '');

  return `Result (${value.type}):\n${display}`;
}

async function clickElement(selector: string): Promise<string> {
  const nodeId = await querySelector(selector);

  // Get element box model for click coordinates
  const box = (await cdp.cmd('DOM.getBoxModel', { nodeId })) as {
    model: {
      content: number[];
      padding: number[];
      border: number[];
      margin: number[];
      width: number;
      height: number;
    };
  };

  if (!box.model) {
    throw new Error(`Cannot get box model for '${selector}' — element may be hidden or detached.`);
  }

  // Box model coordinates: [x1, y1, x2, y2, x3, y3, x4, y4] (top-left, top-right, bottom-right, bottom-left)
  const [x1, y1] = box.model.content;
  const [x3, y3] = [box.model.content[4], box.model.content[5]];
  const clickX = Math.round((x1 + x3) / 2);
  const clickY = Math.round((y1 + y3) / 2);

  // Dispatch mouse events for realistic click behavior
  await cdp.cmd('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: clickX,
    y: clickY,
    button: 'left',
    clickCount: 1,
  });
  await cdp.cmd('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: clickX,
    y: clickY,
    button: 'left',
    clickCount: 1,
  });

  const desc = (await cdp.cmd('DOM.describeNode', { nodeId, depth: 0 })) as {
    node: { localName?: string };
  };
  const tagName = desc?.node?.localName || 'element';
  return `Clicked <${tagName}> at (${clickX}, ${clickY}) for '${selector}'.`;
}

// ── cdp_type ────────────────────────────────────────────────────────────────

async function typeText(selector: string, text: string): Promise<string> {
  await querySelector(selector); // validate element exists

  const expression = `(() => {
    var el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('Element not found');
    var tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || el.isContentEditable) {
      el.value = ${JSON.stringify(text)};
    } else {
      el.textContent = ${JSON.stringify(text)};
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.focus();
    return 'ok';
  })()`;

  await cdp.cmd('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });

  const preview = text.length > 80 ? text.slice(0, 80) + '...' : text;
  return `Typed "${preview}" (${text.length} chars) into '${selector}'.`;
}

// ── cdp_scroll ──────────────────────────────────────────────────────────────

async function scrollTo(selector: string): Promise<string> {
  await querySelector(selector); // validate element exists

  const expression = `(() => {
    var el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('Element not found');
    el.scrollIntoView({ behavior: 'instant', block: 'center' });
    return el.tagName + (el.id ? '#' + el.id : '') + (el.className ? '.' + el.className.slice(0, 40) : '');
  })()`;

  const result = (await cdp.cmd('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })) as { result: { value?: string }; exceptionDetails?: { text?: string } };

  if (result.exceptionDetails) {
    return `Scroll failed: ${result.exceptionDetails.text || 'unknown error'}`;
  }

  return `Scrolled to <${result.result.value || selector}>.`;
}

// ── cdp_select ──────────────────────────────────────────────────────────────

async function selectOption(selector: string, value?: string, text?: string): Promise<string> {
  await querySelector(selector); // validate element exists

  if (!value && !text) {
    return 'Provide either "value" or "text" to select an option.';
  }

  let setValue = '';
  if (value !== undefined) {
    setValue = `el.value = ${JSON.stringify(value)};`;
  } else if (text !== undefined) {
    setValue = [
      `var opt = Array.from(el.options).find(function(o) { return o.text === ${JSON.stringify(text)}; });`,
      `if (opt) el.value = opt.value;`,
    ].join('');
  }

  const expression = `(() => {
    var el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('Element not found');
    if (!(el instanceof HTMLSelectElement)) throw new Error('Element is not a <select>');
    ${setValue}
    el.dispatchEvent(new Event('change', { bubbles: true }));
    var idx = el.selectedIndex;
    return (idx >= 0) ? (el.options[idx].text + ' (' + el.value + ')') : '(none)';
  })()`;

  const result = (await cdp.cmd('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })) as { result: { value?: string }; exceptionDetails?: { text?: string } };

  if (result.exceptionDetails) {
    return `Select failed: ${result.exceptionDetails.text || 'unknown error'}`;
  }

  return `Selected "${result.result.value}" in <select> '${selector}'.`;
}

// ── cdp_hover ────────────────────────────────────────────────────────────────

async function hoverElement(selector: string): Promise<string> {
  const nodeId = await querySelector(selector);

  const box = (await cdp.cmd('DOM.getBoxModel', { nodeId })) as {
    model: { content: number[] };
  };
  if (!box.model) {
    throw new Error(`Cannot get box model for '${selector}' — element may be hidden.`);
  }

  const cx = Math.round((box.model.content[0] + box.model.content[4]) / 2);
  const cy = Math.round((box.model.content[1] + box.model.content[5]) / 2);

  // Move mouse to element center to trigger CSS :hover
  await cdp.cmd('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: cx,
    y: cy,
  });

  const desc = (await cdp.cmd('DOM.describeNode', { nodeId, depth: 0 })) as {
    node: { localName?: string };
  };
  const tagName = desc?.node?.localName || 'element';
  return `Hovered <${tagName}> at (${cx}, ${cy}) for '${selector}'.`;
}

// ── cdp_drag ─────────────────────────────────────────────────────────────────

interface BoxModel {
  content: number[];
  padding: number[];
  border: number[];
  margin: number[];
  width: number;
  height: number;
}

interface ElementPos {
  x: number;
  y: number;
  tagName: string;
}

async function getElementCenter(selector: string): Promise<ElementPos> {
  const nodeId = await querySelector(selector);
  const box = (await cdp.cmd('DOM.getBoxModel', { nodeId })) as { model: BoxModel };
  if (!box.model) {
    throw new Error(`Cannot get box model for '${selector}' — element may be hidden or detached.`);
  }
  const desc = (await cdp.cmd('DOM.describeNode', { nodeId, depth: 0 })) as {
    node: { localName?: string };
  };
  const tagName = desc?.node?.localName || 'element';
  const cx = Math.round((box.model.content[0] + box.model.content[4]) / 2);
  const cy = Math.round((box.model.content[1] + box.model.content[5]) / 2);
  return { x: cx, y: cy, tagName };
}

/**
 * Inject a global __cdpDrag helper into the page.
 * Called once; re-injection is a no-op.
 * The helper runs entirely inside the page's JS context, so DataTransfer
 * state is consistent and no CDP-level coordination is needed mid-drag.
 */
let dragHelperInjected = false;

async function ensureDragHelper(): Promise<void> {
  if (dragHelperInjected) return;

  const injectExpr = `
window.__cdpDrag = function __cdpDrag(opts) {
  /* opts: { sourceSelector, targetSelector, fromX, fromY, toX, toY, steps } */
  var src = document.querySelector(opts.sourceSelector);
  if (!src) return JSON.stringify({error: 'Source element not found: ' + opts.sourceSelector});

  var dt = new DataTransfer();
  dt.effectAllowed = 'all';

  /* If the source is a native draggable, derive sensible defaults */
  var tag = (src.tagName || '').toLowerCase();
  if (tag === 'img' && src.src) {
    dt.setData('text/uri-list', src.src);
    dt.setData('text/plain', src.src);
  } else if (tag === 'a' && src.href) {
    dt.setData('text/uri-list', src.href);
    dt.setData('text/plain', src.href);
    dt.setData('text/html', '<a href=\"' + src.href + '\">' + (src.textContent || '') + '</a>');
  } else if (src.value !== undefined && src.value !== null) {
    dt.setData('text/plain', String(src.value));
  } else {
    var txt = (src.textContent || '').trim().slice(0, 1000);
    if (txt) dt.setData('text/plain', txt);
  }

  /* Dispatch dragstart */
  var dragstart = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt });
  src.dispatchEvent(dragstart);

  /* Compute drop position */
  var toX = opts.toX, toY = opts.toY;
  var dest;
  if (opts.targetSelector) {
    dest = document.querySelector(opts.targetSelector);
    if (dest) {
      var r = dest.getBoundingClientRect();
      toX = r.left + r.width / 2;
      toY = r.top + r.height / 2;
    }
  }

  /* Find the element at drop point for dragenter/dragover */
  var dropEl = dest || document.elementFromPoint(toX, toY) || src;

  /* dragenter + dragover on drop target */
  var enterEvt = new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt });
  dropEl.dispatchEvent(enterEvt);

  var overEvt = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
  dropEl.dispatchEvent(overEvt);

  /* drop */
  var dropEvt = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
  dropEl.dispatchEvent(dropEvt);

  /* dragend on source */
  var endEvt = new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt });
  src.dispatchEvent(endEvt);

  /* Collect drag data for reporting */
  var items = [];
  for (var i = 0; i < dt.items.length; i++) {
    items.push({ mimeType: dt.items[i].type, data: dt.getData(dt.items[i].type) || '' });
  }

  return JSON.stringify({
    ok: true,
    tagName: tag,
    items: items,
    dropTag: (dropEl.tagName || '').toLowerCase()
  });
};`;

  const result = (await cdp.cmd('Runtime.evaluate', {
    expression: injectExpr,
    returnByValue: true,
    awaitPromise: true,
  }, 15_000)) as { exceptionDetails?: { text?: string } };

  if (result.exceptionDetails) {
    throw new Error(`Failed to inject drag helper: ${result.exceptionDetails.text}`);
  }

  dragHelperInjected = true;
}

async function dragElement(
  sourceSelector: string,
  targetSelector?: string,
  x?: number,
  y?: number,
  dx?: number,
  dy?: number,
  steps?: number,
): Promise<string> {
  const source = await getElementCenter(sourceSelector);
  const numSteps = steps && steps > 0 ? steps : 10;

  // Determine drop coordinates
  let dropX: number;
  let dropY: number;
  let dropDesc: string;

  if (x !== undefined && y !== undefined) {
    dropX = Math.round(x);
    dropY = Math.round(y);
    dropDesc = `(${dropX}, ${dropY})`;
  } else if (dx !== undefined && dy !== undefined) {
    dropX = source.x + Math.round(dx);
    dropY = source.y + Math.round(dy);
    dropDesc = `(${source.x}+${Math.round(dx)}, ${source.y}+${Math.round(dy)})`;
  } else if (targetSelector) {
    const target = await getElementCenter(targetSelector);
    dropX = target.x;
    dropY = target.y;
    dropDesc = `<${target.tagName}> ('${targetSelector}')`;
  } else {
    dropX = source.x + 50;
    dropY = source.y + 50;
    dropDesc = `(${source.x}+50, ${source.y}+50)`;
  }

  // Step 1: mousedown on source (for mouse-based drag listeners)
  await cdp.cmd('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: source.x, y: source.y, button: 'left', clickCount: 1,
  });

  // Step 2: Smooth mousemove from source to target
  for (let i = 1; i <= numSteps; i++) {
    const t = i / numSteps;
    await cdp.cmd('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(source.x + (dropX - source.x) * t),
      y: Math.round(source.y + (dropY - source.y) * t),
      button: 'left',
    });
  }

  // Step 3: Inject global helper (once) and run HTML5 DnD inside the page
  try {
    await ensureDragHelper();

    const invokeExpr = `__cdpDrag(${JSON.stringify({
      sourceSelector,
      targetSelector: targetSelector || null,
      fromX: source.x,
      fromY: source.y,
      toX: dropX,
      toY: dropY,
      steps: numSteps,
    })})`;

    const result = (await cdp.cmd('Runtime.evaluate', {
      expression: invokeExpr,
      returnByValue: true,
      awaitPromise: true,
    }, EVALUATE_TIMEOUT)) as {
      result: { value?: string };
      exceptionDetails?: { text?: string };
    };

    if (result.exceptionDetails) {
      // Non-fatal: mouse events alone may be enough
      await cdp.cmd('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: dropX, y: dropY, button: 'left', clickCount: 1,
      });
      return `Dragged <${source.tagName}> from (${source.x}, ${source.y}) to ${dropDesc} (drag helper failed: ${result.exceptionDetails.text}).`;
    }

    const report = JSON.parse(result.result?.value || '{}');
    if (report.error) {
      await cdp.cmd('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: dropX, y: dropY, button: 'left', clickCount: 1,
      });
      return `Dragged <${source.tagName}> from (${source.x}, ${source.y}) to ${dropDesc} (drag helper: ${report.error}).`;
    }

    // Step 4: mouseup (release after DnD sequence)
    await cdp.cmd('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: dropX, y: dropY, button: 'left', clickCount: 1,
    });

    const itemInfo = report.items?.length > 0
      ? ` [${report.items.map((i: { mimeType: string }) => i.mimeType).join(', ')}]`
      : '';

    return `Dragged <${source.tagName}> from (${source.x}, ${source.y}) to ${dropDesc} in ${numSteps} step(s)${itemInfo}.`;
  } catch (err) {
    await cdp.cmd('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: dropX, y: dropY, button: 'left', clickCount: 1,
    });
    const msg = err instanceof Error ? err.message : String(err);
    return `Dragged <${source.tagName}> from (${source.x}, ${source.y}) to ${dropDesc} (drag error: ${msg}).`;
  }
}

// ── cdp_wait ─────────────────────────────────────────────────────────────────

async function waitForElement(selector: string, timeout?: number): Promise<string> {
  const msTimeout = timeout && timeout > 0 ? timeout : 5000;

  const expression = `(async function() {
    var deadline = Date.now() + ${msTimeout};
    var sel = ${JSON.stringify(selector)};
    while (Date.now() < deadline) {
      var el = document.querySelector(sel);
      if (el) {
        var tag = el.tagName || '';
        var id = el.id ? '#' + el.id : '';
        var cls = el.className && typeof el.className === 'string' ? '.' + el.className.slice(0, 30) : '';
        return tag.toLowerCase() + id + cls;
      }
      await new Promise(function(r) { setTimeout(r, 200); });
    }
    throw new Error('Timed out after ' + ${msTimeout} + 'ms waiting for: ' + sel);
  })()`;

  const result = (await cdp.cmd('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })) as {
    result: { value?: string };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };

  if (result.exceptionDetails) {
    const errText =
      result.exceptionDetails.text ||
      result.exceptionDetails.exception?.description ||
      'unknown error';
    return `Wait failed: ${errText}`;
  }

  return `Element found: <${result.result.value}> appeared in the DOM.`;
}

// ── cdp_focus ────────────────────────────────────────────────────────────────

async function focusElement(selector: string): Promise<string> {
  await querySelector(selector); // validate element exists

  const expression = `(() => {
    var el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('Element not found');
    if (typeof el.focus === 'function') el.focus();
    el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('focus', { bubbles: false }));
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '');
  })()`;

  const result = (await cdp.cmd('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })) as {
    result: { value?: string };
    exceptionDetails?: { text?: string };
  };

  if (result.exceptionDetails) {
    return `Focus failed: ${result.exceptionDetails.text || 'unknown error'}`;
  }

  return `Focused <${result.result.value}>.`;
}

// ── cdp_reload ───────────────────────────────────────────────────────────────

async function reloadPage(hard?: boolean, preserveLog?: boolean): Promise<string> {
  const ignoreCache = hard === true;
  await cdp.cmd('Page.reload', { ignoreCache });

  // Wait for page to begin loading
  await new Promise((r) => setTimeout(r, 1000));

  const parts: string[] = ['Page reloaded'];
  if (hard) parts.push('(hard, no cache)');
  if (preserveLog) parts.push('(log preserved)');
  return parts.join(' ') + '.';
}

// ── cdp_network ─────────────────────────────────────────────────────────────

async function getNetwork(limit?: number): Promise<string> {
  const entries = cdp.getNetworkLogs(limit || 20);

  if (entries.length === 0) {
    return 'No network requests captured yet. Open the page or trigger an action that makes requests, then try again.';
  }

  const lines = entries
    .map((e) => {
      const status = e.status ? String(e.status) : '...';
      const duration = e.endTime ? ` (${e.endTime - e.startTime}ms)` : '';
      return `  ${e.method} ${status} ${e.url.slice(0, 200)}${duration}`;
    })
    .reverse(); // most recent first

  return `${entries.length} network request(s):\n\n${lines.join('\n')}`;
}
