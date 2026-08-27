import type { Command, Condition, ValueSpec } from "../core/contracts.js";

const INPUT_TEMPLATE = /{{\s*inputs\.([a-z][A-Za-z0-9_-]*)\s*}}/g;

export class InputValidationError extends Error {
  readonly input: string;

  constructor(input: string, message: string) {
    super(`Invalid input ${input}: ${message}`);
    this.name = "InputValidationError";
    this.input = input;
  }
}

export const validateInputs = (
  specs: Readonly<Record<string, ValueSpec>>,
  values: Readonly<Record<string, unknown>>,
): Record<string, string | number | boolean> => {
  for (const key of Object.keys(values)) {
    if (!(key in specs)) throw new InputValidationError(key, "unknown input");
  }

  const validated: Record<string, string | number | boolean> = {};
  for (const [key, spec] of Object.entries(specs)) {
    const value = values[key];
    if (value === undefined) throw new InputValidationError(key, "value is required");

    switch (spec.type) {
      case "string": {
        if (typeof value !== "string") throw new InputValidationError(key, "expected a string");
        if (value.length > 4_096) {
          throw new InputValidationError(key, "must contain at most 4096 characters");
        }
        if (spec.minLength !== undefined && value.length < spec.minLength) {
          throw new InputValidationError(key, `must contain at least ${spec.minLength} characters`);
        }
        if (spec.maxLength !== undefined && value.length > spec.maxLength) {
          throw new InputValidationError(key, `must contain at most ${spec.maxLength} characters`);
        }
        if (spec.pattern !== undefined && !new RegExp(spec.pattern).test(value)) {
          throw new InputValidationError(key, "does not match the required pattern");
        }
        if (spec.choices !== undefined && !spec.choices.includes(value)) {
          throw new InputValidationError(key, "is not an allowed choice");
        }
        validated[key] = value;
        break;
      }
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new InputValidationError(key, "expected a finite number");
        }
        if (spec.integer && !Number.isInteger(value)) {
          throw new InputValidationError(key, "expected an integer");
        }
        if (spec.minimum !== undefined && value < spec.minimum) {
          throw new InputValidationError(key, `must be at least ${spec.minimum}`);
        }
        if (spec.maximum !== undefined && value > spec.maximum) {
          throw new InputValidationError(key, `must be at most ${spec.maximum}`);
        }
        validated[key] = value;
        break;
      case "boolean":
        if (typeof value !== "boolean") throw new InputValidationError(key, "expected a boolean");
        validated[key] = value;
        break;
    }
  }
  return validated;
};

export const bindTemplate = (
  template: string,
  inputs: Readonly<Record<string, string | number | boolean>>,
): string =>
  template.replace(INPUT_TEMPLATE, (_match, name: string) => {
    const value = inputs[name];
    if (value === undefined) throw new InputValidationError(name, "template references no value");
    return String(value);
  });

const bindUnknown = (
  value: unknown,
  inputs: Readonly<Record<string, string | number | boolean>>,
): unknown => {
  if (typeof value === "string") return bindTemplate(value, inputs);
  if (Array.isArray(value)) return value.map((item) => bindUnknown(item, inputs));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, bindUnknown(child, inputs)]),
    );
  }
  return value;
};

export const bindCommand = (
  command: Command,
  inputs: Readonly<Record<string, string | number | boolean>>,
): Command => bindUnknown(command, inputs) as Command;

export const bindCondition = (
  condition: Condition,
  inputs: Readonly<Record<string, string | number | boolean>>,
): Condition => bindUnknown(condition, inputs) as Condition;

export const parameterizeCommand = (
  command: Command,
  samples: Readonly<Record<string, string | number | boolean>>,
): Command => {
  const parameterize = (value: unknown): unknown => {
    if (typeof value === "string") {
      const exact = Object.entries(samples).find(([, sample]) => String(sample) === value);
      if (exact) return `{{inputs.${exact[0]}}}`;
      return value;
    }
    if (Array.isArray(value)) return value.map(parameterize);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, parameterize(child)]),
      );
    }
    return value;
  };
  return parameterize(command) as Command;
};
