/** The part of JSON Schema the concos tool inputs use. tools/list sends these objects as they are. */
export type ValueSchema =
    | { type: "string"; minLength?: number; maxLength?: number; enum?: readonly string[]; description?: string }
    | { type: "integer"; minimum?: number; maximum?: number; description?: string }
    | { type: "array"; items: ValueSchema; minItems?: number; maxItems?: number; description?: string }
    | { anyOf: ValueSchema[]; description?: string };

export interface InputSchema {
    $schema: string;
    type: "object";
    properties: Record<string, ValueSchema>;
    required?: string[];
}

export type ArgumentCheck = { ok: true; values: Record<string, unknown> } | { ok: false; problems: string[] };

const JSON_SCHEMA_DRAFT = "http://json-schema.org/draft-07/schema#";

/** A tool's input schema; `required` is left out when nothing is required, as clients have seen it so far. */
export function inputSchema(properties: Record<string, ValueSchema>, required: string[] = []): InputSchema {
    const schema: InputSchema = { $schema: JSON_SCHEMA_DRAFT, type: "object", properties: properties };
    if(required.length > 0) {
        schema.required = required;
    }
    return schema;
}

function kindName(schema: ValueSchema): string {
    if("anyOf" in schema) {
        return "a value";
    }
    if(schema.type == "string") {
        return "a string";
    }
    if(schema.type == "integer") {
        return "an integer";
    }
    return "a list";
}

function matchesKind(schema: ValueSchema, value: unknown): boolean {
    if("anyOf" in schema) {
        return false;
    }
    if(schema.type == "string") {
        return typeof value == "string";
    }
    if(schema.type == "integer") {
        return typeof value == "number";
    }
    return Array.isArray(value);
}

function checkValue(schema: ValueSchema, value: unknown, path: string, problems: string[]): void {
    if("anyOf" in schema) {
        // the alternative of the value's own kind names the problem best, e.g. `to` is a string or a list
        const alternative = schema.anyOf.find((option) => matchesKind(option, value));
        if(alternative == null) {
            problems.push(`${path} must be ${schema.anyOf.map(kindName).join(" or ")}`);
            return;
        }
        checkValue(alternative, value, path, problems);
        return;
    }

    if(schema.type == "string") {
        if(typeof value != "string") {
            problems.push(`${path} must be a string`);
            return;
        }
        if(schema.enum != null && schema.enum.includes(value) == false) {
            problems.push(`${path} must be one of ${schema.enum.join(", ")}`);
        }
        if(schema.minLength != null && value.length < schema.minLength) {
            if(schema.minLength == 1) {
                problems.push(`${path} must not be empty`);
            }
            else {
                problems.push(`${path} must have at least ${schema.minLength} characters`);
            }
        }
        if(schema.maxLength != null && value.length > schema.maxLength) {
            problems.push(`${path} must have at most ${schema.maxLength} characters`);
        }
        return;
    }

    if(schema.type == "integer") {
        if(typeof value != "number" || Number.isInteger(value) == false) {
            problems.push(`${path} must be an integer`);
            return;
        }
        if(schema.minimum != null && value < schema.minimum) {
            problems.push(`${path} must be at least ${schema.minimum}`);
        }
        if(schema.maximum != null && value > schema.maximum) {
            problems.push(`${path} must be at most ${schema.maximum}`);
        }
        return;
    }

    if(Array.isArray(value) == false) {
        problems.push(`${path} must be a list`);
        return;
    }
    if(schema.minItems != null && value.length < schema.minItems) {
        if(schema.minItems == 1) {
            problems.push(`${path} must not be empty`);
        }
        else {
            problems.push(`${path} must have at least ${schema.minItems} items`);
        }
    }
    if(schema.maxItems != null && value.length > schema.maxItems) {
        problems.push(`${path} must have at most ${schema.maxItems} items`);
    }
    value.forEach((item, index) => checkValue(schema.items, item, `${path}[${index}]`, problems));
}

/**
 * Checks a tool call's arguments against the tool's input schema. Missing arguments count as an
 * empty object and fields the schema does not name are dropped, as the MCP SDK the tools were first
 * served with did.
 */
export function checkArguments(schema: InputSchema, input: unknown): ArgumentCheck {
    const given = input ?? {};
    if(typeof given != "object" || Array.isArray(given) == true) {
        return { ok: false, problems: ["arguments must be an object"] };
    }
    const fields = given as Record<string, unknown>;
    const problems: string[] = [];
    const values: Record<string, unknown> = {};
    // only an absent field is missing; null is a value of the wrong type, as the schema tells clients
    for(const name of schema.required ?? []) {
        if(fields[name] === undefined) {
            problems.push(`${name} is required`);
        }
    }
    for(const [name, propertySchema] of Object.entries(schema.properties)) {
        const value = fields[name];
        if(value === undefined) {
            continue;
        }
        checkValue(propertySchema, value, name, problems);
        values[name] = value;
    }
    if(problems.length > 0) {
        return { ok: false, problems: problems };
    }
    return { ok: true, values: values };
}
