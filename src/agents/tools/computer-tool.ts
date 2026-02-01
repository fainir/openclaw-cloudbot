/**
 * Computer tool for AI agents to interact with the screen via mouse, keyboard, and screenshots.
 * Uses xdotool for input and scrot for screenshots on EC2 instances with Xvfb.
 */
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import {
  executeComputerAction,
  type ComputerAction,
  type ScrollDirection,
} from "../../cli/nodes-computer.js";
import { stringEnum, optionalStringEnum } from "../schema/typebox.js";
import { sanitizeToolResultImages } from "../tool-images.js";
import { type AnyAgentTool, readStringParam, readNumberParam, jsonResult } from "./common.js";

// All supported actions
const COMPUTER_ACTIONS = [
  "screenshot",
  "mouse_move",
  "left_click",
  "right_click",
  "double_click",
  "middle_click",
  "triple_click",
  "left_click_drag",
  "left_mouse_down",
  "left_mouse_up",
  "key",
  "type",
  "cursor_position",
  "scroll",
  "wait",
  "hold_key",
] as const;

const SCROLL_DIRECTIONS = ["up", "down", "left", "right"] as const;

// Tool schema
const ComputerToolSchema = Type.Object({
  action: stringEnum(COMPUTER_ACTIONS, {
    description: `The action to perform on the computer. Actions:
- screenshot: Capture a screenshot of the current screen
- mouse_move: Move the mouse to a coordinate (requires coordinate)
- left_click: Left click at current position or coordinate
- right_click: Right click at current position or coordinate
- double_click: Double click at current position or coordinate
- middle_click: Middle click at current position or coordinate
- triple_click: Triple click at current position or coordinate
- left_click_drag: Click and drag from current position to coordinate (requires coordinate)
- left_mouse_down: Press and hold left mouse button
- left_mouse_up: Release left mouse button
- key: Press a key or key combination (requires text, e.g. "Return", "ctrl+c", "alt+Tab")
- type: Type text string (requires text)
- cursor_position: Get current cursor coordinates
- scroll: Scroll in a direction (requires scrollDirection and scrollAmount)
- wait: Wait for a duration (requires duration in seconds)
- hold_key: Hold a key for a duration (requires text and duration)`,
  }),
  // Use Unsafe to generate valid JSON Schema draft 2020-12 (Type.Tuple uses additionalItems which is deprecated)
  coordinate: Type.Optional(
    Type.Unsafe<[number, number]>({
      type: "array",
      items: { type: "number" },
      minItems: 2,
      maxItems: 2,
      description:
        "The [x, y] coordinate for mouse actions. Origin is top-left. Coordinates are in API space (default 1280x800) and scaled to actual screen resolution.",
    }),
  ),
  text: Type.Optional(
    Type.String({
      description:
        "For 'key' action: key name or combination (e.g. 'Return', 'ctrl+c', 'alt+Tab'). For 'type' action: the text to type. For 'hold_key' action: the key to hold.",
    }),
  ),
  scrollDirection: optionalStringEnum(SCROLL_DIRECTIONS, {
    description: "Direction to scroll (required for scroll action)",
  }),
  scrollAmount: Type.Optional(
    Type.Number({
      description: "Number of scroll clicks (default 3)",
    }),
  ),
  duration: Type.Optional(
    Type.Number({
      description: "Duration in seconds for wait or hold_key actions (max 100)",
    }),
  ),
  key: Type.Optional(
    Type.String({
      description: "Modifier key to hold during click actions (e.g. 'shift', 'ctrl')",
    }),
  ),
});

export interface ComputerToolOptions {
  /** API coordinate space width (default 1280) */
  displayWidth?: number;
  /** API coordinate space height (default 800) */
  displayHeight?: number;
  /** Actual screen width (default 1920) */
  screenWidth?: number;
  /** Actual screen height (default 1080) */
  screenHeight?: number;
  /** X display number (default :99 for Xvfb) */
  displayNum?: number;
}

export function createComputerTool(options?: ComputerToolOptions): AnyAgentTool {
  const displayWidth = options?.displayWidth ?? 1280;
  const displayHeight = options?.displayHeight ?? 800;
  const screenWidth = options?.screenWidth ?? 1920;
  const screenHeight = options?.screenHeight ?? 1080;
  const displayNum = options?.displayNum;

  return {
    label: "Computer",
    name: "computer",
    description: `Control the computer screen with mouse, keyboard, and screenshots. Use this tool to interact with GUI applications.

Available actions:
- screenshot: See what's on screen
- mouse_move: Move cursor to coordinates
- left_click, right_click, double_click, middle_click, triple_click: Click actions
- left_click_drag: Drag from current position to coordinates
- key: Press key combinations (e.g. "Return", "ctrl+c", "alt+Tab")
- type: Type text
- scroll: Scroll in a direction
- cursor_position: Get current cursor position
- wait: Wait for UI to update
- hold_key: Hold a key for a duration

Coordinates are in a ${displayWidth}x${displayHeight} space. Always take a screenshot first to see the current state before interacting.`,
    parameters: ComputerToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true }) as ComputerAction;

      // Parse coordinate if provided
      let coordinate: [number, number] | undefined;
      if (Array.isArray(params.coordinate) && params.coordinate.length === 2) {
        const x = typeof params.coordinate[0] === "number" ? params.coordinate[0] : 0;
        const y = typeof params.coordinate[1] === "number" ? params.coordinate[1] : 0;
        coordinate = [x, y];
      }

      // Parse other parameters
      const text = typeof params.text === "string" ? params.text : undefined;
      const scrollDirection =
        typeof params.scrollDirection === "string"
          ? (params.scrollDirection as ScrollDirection)
          : undefined;
      const scrollAmount = readNumberParam(params, "scrollAmount");
      const duration = readNumberParam(params, "duration");
      const key = typeof params.key === "string" ? params.key : undefined;

      try {
        const result = await executeComputerAction({
          action,
          coordinate,
          text,
          scrollDirection,
          scrollAmount,
          duration,
          key,
          displayNum,
          displayWidth,
          displayHeight,
          screenWidth,
          screenHeight,
        });

        if (!result.success) {
          return jsonResult({ success: false, error: result.error });
        }

        // Build response content
        const content: AgentToolResult<unknown>["content"] = [];

        // Add text output if present
        if (result.output) {
          content.push({ type: "text", text: result.output });
        }

        // Add cursor position if present
        if (result.cursorPosition) {
          content.push({
            type: "text",
            text: `Cursor position: (${result.cursorPosition[0]}, ${result.cursorPosition[1]})`,
          });
        }

        // Add screenshot if present
        if (result.screenshot) {
          content.push({
            type: "text",
            text: `[Screenshot captured after ${action}]`,
          });
          content.push({
            type: "image",
            data: result.screenshot,
            mimeType: "image/png",
          });
        }

        // If no content, add success message
        if (content.length === 0) {
          content.push({ type: "text", text: `Action '${action}' completed successfully` });
        }

        const toolResult: AgentToolResult<unknown> = {
          content,
          details: {
            action,
            success: true,
            cursorPosition: result.cursorPosition,
            hasScreenshot: Boolean(result.screenshot),
          },
        };

        // Sanitize images to ensure they fit API limits
        return await sanitizeToolResultImages(toolResult, "computer");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },
  };
}
