import { spawn } from "node:child_process";
/**
 * Computer use utilities for screenshot capture and input injection via xdotool/scrot.
 * Used by the computer tool to control GUI on EC2 instances with Xvfb.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveCliName } from "./cli-name.js";

// Constants
const TYPING_DELAY_MS = 12;
const TYPING_GROUP_SIZE = 50;
const SCREENSHOT_DELAY_MS = 200;
const DEFAULT_DISPLAY = ":99";

// Action types matching Anthropic's computer use API
export type ComputerAction =
  | "screenshot"
  | "mouse_move"
  | "left_click"
  | "right_click"
  | "double_click"
  | "middle_click"
  | "triple_click"
  | "left_click_drag"
  | "left_mouse_down"
  | "left_mouse_up"
  | "key"
  | "type"
  | "cursor_position"
  | "scroll"
  | "wait"
  | "hold_key";

export type ScrollDirection = "up" | "down" | "left" | "right";

export interface ComputerActionParams {
  action: ComputerAction;
  coordinate?: [number, number];
  text?: string;
  scrollDirection?: ScrollDirection;
  scrollAmount?: number;
  duration?: number;
  key?: string;
  displayNum?: number;
  displayWidth?: number;
  displayHeight?: number;
  screenWidth?: number;
  screenHeight?: number;
}

export interface ComputerActionResult {
  success: boolean;
  screenshot?: string; // base64 PNG
  cursorPosition?: [number, number];
  output?: string;
  error?: string;
}

// Click button mappings for xdotool
const CLICK_BUTTONS: Record<string, string> = {
  left_click: "1",
  right_click: "3",
  middle_click: "2",
  double_click: "--repeat 2 --delay 10 1",
  triple_click: "--repeat 3 --delay 10 1",
};

// Scroll button mappings for xdotool
const SCROLL_BUTTONS: Record<ScrollDirection, number> = {
  up: 4,
  down: 5,
  left: 6,
  right: 7,
};

function getDisplayPrefix(displayNum?: number): string {
  const display =
    displayNum !== undefined ? `:${displayNum}` : process.env.DISPLAY || DEFAULT_DISPLAY;
  return `DISPLAY=${display}`;
}

function getXdotoolCommand(displayNum?: number): string {
  return `${getDisplayPrefix(displayNum)} xdotool`;
}

/**
 * Execute a shell command and return stdout/stderr
 */
async function execCommand(
  command: string,
  options?: { timeoutMs?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], {
      timeout: options?.timeoutMs ?? 30000,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });

    child.on("error", (err) => {
      stderr += err.message;
      resolve({ stdout, stderr, exitCode: 1 });
    });
  });
}

/**
 * Scale coordinates from API space to actual screen resolution
 */
export function scaleCoordinates(
  apiX: number,
  apiY: number,
  apiWidth: number,
  apiHeight: number,
  screenWidth: number,
  screenHeight: number,
): [number, number] {
  const scaledX = Math.round((apiX / apiWidth) * screenWidth);
  const scaledY = Math.round((apiY / apiHeight) * screenHeight);
  return [scaledX, scaledY];
}

/**
 * Get temp path for screenshot files
 */
export function computerTempPath(opts?: { tmpDir?: string; id?: string }): string {
  const tmpDir = opts?.tmpDir ?? os.tmpdir();
  const id = opts?.id ?? randomUUID();
  const cliName = resolveCliName();
  return path.join(tmpDir, `${cliName}-computer-screenshot-${id}.png`);
}

/**
 * Capture a screenshot using scrot or gnome-screenshot
 */
export async function captureScreenshot(params: {
  displayNum?: number;
  scaleTo?: { width: number; height: number };
}): Promise<{ base64: string; path: string }> {
  const filePath = computerTempPath();
  const displayPrefix = getDisplayPrefix(params.displayNum);

  // Try scrot first (preferred for headless), then gnome-screenshot
  let result = await execCommand(`${displayPrefix} scrot -o ${filePath}`);

  if (result.exitCode !== 0) {
    // Try gnome-screenshot as fallback
    result = await execCommand(`${displayPrefix} gnome-screenshot -f ${filePath}`);
  }

  if (result.exitCode !== 0) {
    throw new Error(`Screenshot failed: ${result.stderr || "unknown error"}`);
  }

  // Scale if needed
  if (params.scaleTo) {
    const { width, height } = params.scaleTo;
    await execCommand(`convert ${filePath} -resize ${width}x${height}! ${filePath}`);
  }

  // Read and encode
  const buffer = await fs.readFile(filePath);
  const base64 = buffer.toString("base64");

  return { base64, path: filePath };
}

/**
 * Get current cursor position
 */
export async function getCursorPosition(displayNum?: number): Promise<[number, number]> {
  const xdotool = getXdotoolCommand(displayNum);
  const result = await execCommand(`${xdotool} getmouselocation --shell`);

  if (result.exitCode !== 0) {
    throw new Error(`Failed to get cursor position: ${result.stderr}`);
  }

  const output = result.stdout;
  const x = parseInt(output.split("X=")[1]?.split("\n")[0] ?? "0", 10);
  const y = parseInt(output.split("Y=")[1]?.split("\n")[0] ?? "0", 10);

  return [x, y];
}

/**
 * Move mouse to coordinates
 */
export async function mouseMove(x: number, y: number, displayNum?: number): Promise<void> {
  const xdotool = getXdotoolCommand(displayNum);
  const result = await execCommand(`${xdotool} mousemove --sync ${x} ${y}`);

  if (result.exitCode !== 0) {
    throw new Error(`Mouse move failed: ${result.stderr}`);
  }
}

/**
 * Perform a mouse click
 */
export async function mouseClick(
  action: "left_click" | "right_click" | "middle_click" | "double_click" | "triple_click",
  coordinate?: [number, number],
  modifierKey?: string,
  displayNum?: number,
): Promise<void> {
  const xdotool = getXdotoolCommand(displayNum);
  const parts: string[] = [xdotool];

  // Move to coordinate if specified
  if (coordinate) {
    parts.push(`mousemove --sync ${coordinate[0]} ${coordinate[1]}`);
  }

  // Hold modifier key if specified
  if (modifierKey) {
    parts.push(`keydown ${modifierKey}`);
  }

  // Click
  parts.push(`click ${CLICK_BUTTONS[action]}`);

  // Release modifier key if specified
  if (modifierKey) {
    parts.push(`keyup ${modifierKey}`);
  }

  const result = await execCommand(parts.join(" "));

  if (result.exitCode !== 0) {
    throw new Error(`Mouse click failed: ${result.stderr}`);
  }
}

/**
 * Click and drag
 */
export async function leftClickDrag(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  displayNum?: number,
): Promise<void> {
  const xdotool = getXdotoolCommand(displayNum);
  const result = await execCommand(
    `${xdotool} mousemove --sync ${startX} ${startY} mousedown 1 mousemove --sync ${endX} ${endY} mouseup 1`,
  );

  if (result.exitCode !== 0) {
    throw new Error(`Click drag failed: ${result.stderr}`);
  }
}

/**
 * Mouse down/up
 */
export async function mouseButton(
  action: "left_mouse_down" | "left_mouse_up",
  displayNum?: number,
): Promise<void> {
  const xdotool = getXdotoolCommand(displayNum);
  const cmd = action === "left_mouse_down" ? "mousedown 1" : "mouseup 1";
  const result = await execCommand(`${xdotool} ${cmd}`);

  if (result.exitCode !== 0) {
    throw new Error(`Mouse button failed: ${result.stderr}`);
  }
}

/**
 * Scroll in a direction
 */
export async function scroll(
  direction: ScrollDirection,
  amount: number,
  coordinate?: [number, number],
  modifierKey?: string,
  displayNum?: number,
): Promise<void> {
  const xdotool = getXdotoolCommand(displayNum);
  const parts: string[] = [xdotool];

  // Move to coordinate if specified
  if (coordinate) {
    parts.push(`mousemove --sync ${coordinate[0]} ${coordinate[1]}`);
  }

  // Hold modifier key if specified
  if (modifierKey) {
    parts.push(`keydown ${modifierKey}`);
  }

  // Scroll
  const button = SCROLL_BUTTONS[direction];
  parts.push(`click --repeat ${amount} ${button}`);

  // Release modifier key if specified
  if (modifierKey) {
    parts.push(`keyup ${modifierKey}`);
  }

  const result = await execCommand(parts.join(" "));

  if (result.exitCode !== 0) {
    throw new Error(`Scroll failed: ${result.stderr}`);
  }
}

/**
 * Press a key combination
 */
export async function keyPress(keys: string, displayNum?: number): Promise<void> {
  const xdotool = getXdotoolCommand(displayNum);
  const result = await execCommand(`${xdotool} key -- ${keys}`);

  if (result.exitCode !== 0) {
    throw new Error(`Key press failed: ${result.stderr}`);
  }
}

/**
 * Type text with optional delay
 */
export async function typeText(text: string, displayNum?: number): Promise<void> {
  const xdotool = getXdotoolCommand(displayNum);

  // Type in chunks to avoid issues with long text
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += TYPING_GROUP_SIZE) {
    chunks.push(text.slice(i, i + TYPING_GROUP_SIZE));
  }

  for (const chunk of chunks) {
    // Escape special characters for shell
    const escaped = chunk.replace(/'/g, "'\\''");
    const result = await execCommand(`${xdotool} type --delay ${TYPING_DELAY_MS} -- '${escaped}'`);

    if (result.exitCode !== 0) {
      throw new Error(`Type text failed: ${result.stderr}`);
    }
  }
}

/**
 * Hold a key for a duration
 */
export async function holdKey(
  keys: string,
  durationSec: number,
  displayNum?: number,
): Promise<void> {
  const xdotool = getXdotoolCommand(displayNum);
  const result = await execCommand(
    `${xdotool} keydown ${keys} && sleep ${durationSec} && ${xdotool} keyup ${keys}`,
  );

  if (result.exitCode !== 0) {
    throw new Error(`Hold key failed: ${result.stderr}`);
  }
}

/**
 * Wait for a duration
 */
export async function wait(durationSec: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, durationSec * 1000));
}

/**
 * Execute a computer action and return the result
 */
export async function executeComputerAction(
  params: ComputerActionParams,
): Promise<ComputerActionResult> {
  const {
    action,
    coordinate,
    text,
    scrollDirection,
    scrollAmount,
    duration,
    key,
    displayNum,
    displayWidth = 1280,
    displayHeight = 800,
    screenWidth = 1920,
    screenHeight = 1080,
  } = params;

  try {
    // Scale coordinates if provided
    let scaledCoord: [number, number] | undefined;
    if (coordinate) {
      scaledCoord = scaleCoordinates(
        coordinate[0],
        coordinate[1],
        displayWidth,
        displayHeight,
        screenWidth,
        screenHeight,
      );
    }

    switch (action) {
      case "screenshot": {
        const { base64 } = await captureScreenshot({
          displayNum,
          scaleTo: { width: displayWidth, height: displayHeight },
        });
        return { success: true, screenshot: base64 };
      }

      case "cursor_position": {
        const [x, y] = await getCursorPosition(displayNum);
        // Scale back to API coordinates
        const apiX = Math.round((x / screenWidth) * displayWidth);
        const apiY = Math.round((y / screenHeight) * displayHeight);
        return { success: true, cursorPosition: [apiX, apiY], output: `X=${apiX},Y=${apiY}` };
      }

      case "mouse_move": {
        if (!scaledCoord) {
          return { success: false, error: "coordinate required for mouse_move" };
        }
        await mouseMove(scaledCoord[0], scaledCoord[1], displayNum);
        // Take screenshot after action
        await wait(SCREENSHOT_DELAY_MS / 1000);
        const { base64 } = await captureScreenshot({
          displayNum,
          scaleTo: { width: displayWidth, height: displayHeight },
        });
        return { success: true, screenshot: base64 };
      }

      case "left_click":
      case "right_click":
      case "middle_click":
      case "double_click":
      case "triple_click": {
        await mouseClick(action, scaledCoord, key, displayNum);
        await wait(SCREENSHOT_DELAY_MS / 1000);
        const { base64 } = await captureScreenshot({
          displayNum,
          scaleTo: { width: displayWidth, height: displayHeight },
        });
        return { success: true, screenshot: base64 };
      }

      case "left_click_drag": {
        if (!scaledCoord) {
          return { success: false, error: "coordinate required for left_click_drag" };
        }
        const [cursorX, cursorY] = await getCursorPosition(displayNum);
        await leftClickDrag(cursorX, cursorY, scaledCoord[0], scaledCoord[1], displayNum);
        await wait(SCREENSHOT_DELAY_MS / 1000);
        const { base64 } = await captureScreenshot({
          displayNum,
          scaleTo: { width: displayWidth, height: displayHeight },
        });
        return { success: true, screenshot: base64 };
      }

      case "left_mouse_down":
      case "left_mouse_up": {
        await mouseButton(action, displayNum);
        await wait(SCREENSHOT_DELAY_MS / 1000);
        const { base64 } = await captureScreenshot({
          displayNum,
          scaleTo: { width: displayWidth, height: displayHeight },
        });
        return { success: true, screenshot: base64 };
      }

      case "scroll": {
        if (!scrollDirection) {
          return { success: false, error: "scrollDirection required for scroll" };
        }
        const amount = scrollAmount ?? 3;
        await scroll(scrollDirection, amount, scaledCoord, text, displayNum);
        await wait(SCREENSHOT_DELAY_MS / 1000);
        const { base64 } = await captureScreenshot({
          displayNum,
          scaleTo: { width: displayWidth, height: displayHeight },
        });
        return { success: true, screenshot: base64 };
      }

      case "key": {
        if (!text) {
          return { success: false, error: "text (key combination) required for key action" };
        }
        await keyPress(text, displayNum);
        await wait(SCREENSHOT_DELAY_MS / 1000);
        const { base64 } = await captureScreenshot({
          displayNum,
          scaleTo: { width: displayWidth, height: displayHeight },
        });
        return { success: true, screenshot: base64 };
      }

      case "type": {
        if (!text) {
          return { success: false, error: "text required for type action" };
        }
        await typeText(text, displayNum);
        await wait(SCREENSHOT_DELAY_MS / 1000);
        const { base64 } = await captureScreenshot({
          displayNum,
          scaleTo: { width: displayWidth, height: displayHeight },
        });
        return { success: true, screenshot: base64 };
      }

      case "hold_key": {
        if (!text) {
          return { success: false, error: "text (key) required for hold_key action" };
        }
        if (duration === undefined || duration <= 0) {
          return { success: false, error: "duration required for hold_key action" };
        }
        if (duration > 100) {
          return { success: false, error: "duration too long (max 100 seconds)" };
        }
        await holdKey(text, duration, displayNum);
        await wait(SCREENSHOT_DELAY_MS / 1000);
        const { base64 } = await captureScreenshot({
          displayNum,
          scaleTo: { width: displayWidth, height: displayHeight },
        });
        return { success: true, screenshot: base64 };
      }

      case "wait": {
        if (duration === undefined || duration <= 0) {
          return { success: false, error: "duration required for wait action" };
        }
        if (duration > 100) {
          return { success: false, error: "duration too long (max 100 seconds)" };
        }
        await wait(duration);
        const { base64 } = await captureScreenshot({
          displayNum,
          scaleTo: { width: displayWidth, height: displayHeight },
        });
        return { success: true, screenshot: base64 };
      }

      default:
        return { success: false, error: `Unknown action: ${action}` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

/**
 * Parse computer action payload from node invoke result
 */
export function parseComputerActionPayload(value: unknown): ComputerActionResult {
  if (!value || typeof value !== "object") {
    return { success: false, error: "invalid payload" };
  }

  const obj = value as Record<string, unknown>;
  return {
    success: obj.success === true,
    screenshot: typeof obj.screenshot === "string" ? obj.screenshot : undefined,
    cursorPosition: Array.isArray(obj.cursorPosition)
      ? (obj.cursorPosition as [number, number])
      : undefined,
    output: typeof obj.output === "string" ? obj.output : undefined,
    error: typeof obj.error === "string" ? obj.error : undefined,
  };
}
