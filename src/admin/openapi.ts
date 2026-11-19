// Hand-written OpenAPI 3.1 for the agent-facing part of the API. Not every route is here.
// test/openapi.test.ts calls each path below, so a path that is not routed fails the suite.

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown) => ({ "application/json": { schema } });
const ok = (description: string, schema: unknown) => ({ description, content: json(schema) });
const err = (description: string) => ({ description, content: json(ref("Error")) });
const circleParams = [{ $ref: "#/components/parameters/CircleHeader" }, { $ref: "#/components/parameters/CircleQuery" }];
const idParam = { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } };
const allParam = {
  name: "all",
  in: "query",
  description: "Set to 1 to list every circle you are in instead of one.",
  schema: { type: "string", enum: ["1"] },
};
const nullable = (schema: Record<string, unknown>) => ({ ...schema, type: [schema.type, "null"] });

const unauthorized = { "401": err("Missing or invalid token") };
const bad = { "400": err("Invalid input") };

const replyBody = {
  required: true,
  content: json({
    type: "object",
    required: ["reply"],
    properties: {
      reply: { type: "string", enum: ["in", "maybe", "can't"], description: "Stored as coming, maybe or declined." },
    },
  }),
};

/** Join, leave and reply share one shape for socials and plans. */
function action(kind: "social" | "plan", verb: "join" | "leave" | "reply", summary: string) {
  return {
    post: {
      summary,
      tags: [`${kind}s`],
      security: [{ bearer: [] }],
      parameters: [idParam, ...circleParams],
      ...(verb === "reply" ? { requestBody: replyBody } : {}),
      responses: {
        "200": ok("The updated " + kind, { type: "object", properties: { [kind]: ref(kind === "social" ? "Social" : "Plan") } }),
        ...bad,
        ...unauthorized,
        "404": err(`${kind} not found`),
      },
    },
  };
}

const note = { type: "string", maxLength: 80 };
const place = { type: "string", description: "Free text place name." };
const lat = { type: "number", minimum: -90, maximum: 90 };
const lng = { type: "number", minimum: -180, maximum: 180 };
const circleBody = { circleId: { type: "string", format: "uuid", description: "Alternative to the X-Circle header." } };

const statusBody = {
  required: true,
  content: json({
    type: "object",
    required: ["type"],
    properties: {
      type: { type: "string", enum: ["away", "busy"] },
      text: { type: "string", maxLength: 60 },
      place: { type: "string", maxLength: 40 },
      untilDay: { type: "string", format: "date", description: "Last day of the status, a calendar date in Europe/Berlin." },
    },
  }),
};
const statusWrite = (summary: string) => ({
  summary,
  tags: ["status"],
  security: [{ bearer: [] }],
  requestBody: statusBody,
  responses: { "200": ok("Same shape as GET /api/me", ref("Me")), ...bad, ...unauthorized },
});

const person = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string" },
    color: { type: "string", description: "Hex color." },
    avatarRev: nullable({ type: "integer" }),
    status: { oneOf: [ref("Status"), { type: "null" }] },
    paymentUrl: nullable({ type: "string" }),
    weroEmail: nullable({ type: "string", format: "email" }),
  },
};
const availability = {
  type: "object",
  description: "Busy or free from a shared calendar. Never an event title.",
  properties: { state: { type: "string", enum: ["busy", "free"] }, until: nullable({ type: "integer" }) },
};
const joined = {
  type: "array",
  items: {
    allOf: [
      person,
      {
        type: "object",
        properties: {
          joinedAt: { type: "integer" },
          reply: { type: "string", enum: ["join", "coming", "maybe", "declined"] },
          arriveAt: nullable({ type: "integer" }),
        },
      },
    ],
  },
};
const eventFields = {
  id: { type: "string", format: "uuid" },
  note: { type: "string" },
  place: { type: "string" },
  location: { oneOf: [{ type: "object", properties: { lat, lng } }, { type: "null" }] },
  circleId: { type: "string", format: "uuid" },
  circleName: { type: "string" },
  createdAt: { type: "integer", description: "Epoch ms." },
  creator: person,
  joined,
};

export const openapi = {
  openapi: "3.1.0",
  info: {
    title: "Hangry agent API",
    version: "1.0.0",
    description:
      "Hangry is an invite-only friends app. An agent acts as the person who created its token, and friends see its actions as that person. Plain-text guide: /llms.txt.",
  },
  servers: [{ url: "https://imhangry.app" }],
  security: [{ bearer: [] }],
  paths: {
    "/api/openapi.json": {
      get: { summary: "This document", tags: ["public"], security: [], responses: { "200": { description: "OpenAPI 3.1 JSON" } } },
    },
    "/llms.txt": {
      get: { summary: "Plain-text guide for agents", tags: ["public"], security: [], responses: { "200": { description: "text/plain" } } },
    },
    "/api/health": {
      get: {
        summary: "Liveness check",
        tags: ["public"],
        security: [],
        responses: { "200": ok("Alive", { type: "object", properties: { ok: { type: "boolean" } } }) },
      },
    },
    "/api/me": {
      get: {
        summary: "Who you are, your circles, and the members of the current circle with their status",
        tags: ["me"],
        parameters: circleParams,
        responses: { "200": ok("Profile", ref("Me")), ...unauthorized, "404": err("Circle not found") },
      },
    },
    "/api/me/status": {
      get: {
        summary: "Your own status",
        tags: ["status"],
        responses: {
          "200": ok("Status or null", { type: "object", properties: { status: { oneOf: [ref("Status"), { type: "null" }] } } }),
          ...unauthorized,
        },
      },
      put: statusWrite("Set Away or Busy"),
      patch: statusWrite("Set Away or Busy (same as PUT)"),
      delete: {
        summary: "Clear your status",
        tags: ["status"],
        responses: { "200": ok("Same shape as GET /api/me", ref("Me")), ...unauthorized },
      },
    },
    "/api/socials": {
      get: {
        summary: "Active socials in the current circle",
        tags: ["socials"],
        parameters: [allParam, ...circleParams],
        responses: {
          "200": ok("Socials", { type: "object", properties: { socials: { type: "array", items: ref("Social") } } }),
          ...unauthorized,
        },
      },
      post: {
        summary: "Start a social (free now). If you already have one live, it is updated.",
        tags: ["socials"],
        parameters: circleParams,
        requestBody: {
          content: json({ type: "object", properties: { note, place, lat, lng, ...circleBody } }),
        },
        responses: {
          "201": ok("Created", { type: "object", properties: { social: ref("Social") } }),
          "200": ok("Updated your live social", { type: "object", properties: { social: ref("Social") } }),
          ...bad,
          ...unauthorized,
        },
      },
    },
    "/api/socials/{id}/join": action("social", "join", "Say I'm in"),
    "/api/socials/{id}/leave": action("social", "leave", "Take back your join"),
    "/api/socials/{id}/reply": action("social", "reply", "Reply in, maybe or can't"),
    "/api/plans": {
      get: {
        summary: "Upcoming plans in the current circle",
        tags: ["plans"],
        parameters: [allParam, ...circleParams],
        responses: {
          "200": ok("Plans", { type: "object", properties: { plans: { type: "array", items: ref("Plan") } } }),
          ...unauthorized,
        },
      },
      post: {
        summary: "Make a plan",
        tags: ["plans"],
        parameters: circleParams,
        requestBody: {
          required: true,
          content: json({
            type: "object",
            required: ["note"],
            properties: {
              note,
              date: { type: "string", format: "date", description: "YYYY-MM-DD. Default is tomorrow." },
              time: { type: "string", pattern: "^\\d{2}:\\d{2}$", description: "HH:MM, 24 hour." },
              place,
              description: { type: "string", description: "Optional. One line, longer text is cut at 280." },
              lat,
              lng,
              ...circleBody,
            },
          }),
        },
        responses: {
          "201": ok("Created", { type: "object", properties: { plan: ref("Plan") } }),
          ...bad,
          ...unauthorized,
        },
      },
    },
    "/api/plans/{id}/join": action("plan", "join", "Say I'm in"),
    "/api/plans/{id}/leave": action("plan", "leave", "Take back your join"),
    "/api/plans/{id}/reply": action("plan", "reply", "Reply in, maybe or can't"),
    "/api/circles/availability": {
      get: {
        summary: "Friends who shared a calendar: busy or free, no event titles",
        tags: ["circles"],
        parameters: [
          { name: "at", in: "query", description: "Epoch ms, up to 30 days ahead. Default now.", schema: { type: "integer" } },
          ...circleParams,
        ],
        responses: {
          "200": ok("Availability", {
            type: "object",
            properties: {
              at: { type: "integer" },
              people: { type: "array", items: { allOf: [{ type: "object", properties: { id: { type: "string", format: "uuid" } } }, availability] } },
            },
          }),
          ...bad,
          ...unauthorized,
        },
      },
    },
    "/api/notifications": {
      get: {
        summary: "Alerts for the current circle",
        tags: ["notifications"],
        parameters: circleParams,
        responses: {
          "200": ok("Alerts", {
            type: "object",
            properties: {
              notifications: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    title: { type: "string" },
                    body: { type: "string" },
                    kind: { type: "string" },
                    refId: nullable({ type: "string" }),
                    circleId: nullable({ type: "string" }),
                    createdAt: { type: "integer" },
                    readAt: nullable({ type: "integer" }),
                  },
                },
              },
              unreadByCircle: { type: "object", additionalProperties: { type: "integer" } },
            },
          }),
          ...unauthorized,
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearer: {
        type: "http",
        scheme: "bearer",
        description: "An agent token from the You tab in the app. It starts with hng_ and is shown once.",
      },
    },
    parameters: {
      CircleHeader: {
        name: "X-Circle",
        in: "header",
        description: "Circle id. Optional if you are in exactly one circle.",
        schema: { type: "string", format: "uuid" },
      },
      CircleQuery: {
        name: "circle",
        in: "query",
        description: "Same as X-Circle.",
        schema: { type: "string", format: "uuid" },
      },
    },
    schemas: {
      Error: { type: "object", properties: { error: { type: "string" } } },
      Status: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["away", "busy"] },
          text: nullable({ type: "string" }),
          place: nullable({ type: "string" }),
          until: nullable({ type: "integer" }),
        },
      },
      Me: {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: { ...person.properties, calendarConnected: { type: "boolean" } },
          },
          circles: {
            type: "array",
            items: {
              type: "object",
              properties: { id: { type: "string", format: "uuid" }, name: { type: "string" }, admin: { type: "boolean" } },
            },
          },
          circle: {
            description: "The current circle, or null if you are in none.",
            oneOf: [
              {
                type: "object",
                properties: {
                  id: { type: "string", format: "uuid" },
                  name: { type: "string" },
                  members: {
                    type: "array",
                    items: { allOf: [person, { type: "object", properties: { availability: { oneOf: [availability, { type: "null" }] } } }] },
                  },
                },
              },
              { type: "null" },
            ],
          },
        },
      },
      Social: {
        type: "object",
        properties: {
          ...eventFields,
          startsAt: nullable({ type: "integer" }),
          buzzedAt: nullable({ type: "integer" }),
          expiresAt: { type: "integer" },
        },
      },
      Plan: {
        type: "object",
        properties: {
          ...eventFields,
          forDate: { type: "string", format: "date" },
          time: nullable({ type: "string" }),
          whenLabel: { type: "string" },
        },
      },
    },
  },
};

export type Operation = { method: string; path: string };

/** Every method and path template in the document, like { method: "POST", path: "/api/plans/{id}/join" }. */
export function listOperations(doc: { paths: Record<string, object> } = openapi): Operation[] {
  return Object.entries(doc.paths).flatMap(([path, item]) =>
    Object.keys(item).map((method) => ({ method: method.toUpperCase(), path })),
  );
}

/** Each documented operation as a method and a regex, where {param} matches one path segment. */
const allowed = listOperations().map(({ method, path }) => ({
  method,
  re: new RegExp("^" + path.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{[^}]+\}/g, "[^/]+") + "$"),
}));

export const AGENT_ROUTES_ERROR = "agent tokens can only use routes in /api/openapi.json";

/** True when the method and pathname match an operation in the document. Agent tokens may call only these. */
export function isAgentAllowed(method: string, pathname: string): boolean {
  const m = method.toUpperCase();
  return allowed.some((op) => op.method === m && op.re.test(pathname));
}

export const openapiJson = JSON.stringify(openapi);
