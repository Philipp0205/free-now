// Plain-text guide served at GET /llms.txt. Static, public, no user data.

export const llmsTxt = `# Spontaco

Spontaco is an invite-only app for friends to say when they are free and to make plans.
This guide is for AI agents and scripts acting for one person.
Origin: https://imhangry.app
Full request and response shapes: GET https://imhangry.app/api/openapi.json

## Auth

Send \`Authorization: Bearer <token>\` on every call except the public ones
(/llms.txt, /api/openapi.json, /api/health).

The person creates the token on the You tab in the app. It starts with hng_,
is shown once, and they can revoke it there at any time.

Everything you do appears to their friends as that person. Ask before you post.
Agent tokens can only call the routes listed in /api/openapi.json. Any other route
is refused with 403.

## Circles

A circle is a group of friends. If the person is in exactly one circle, you can
leave it out. Otherwise pick one with the header \`X-Circle: <circle id>\`, the
query \`?circle=<circle id>\`, or \`circleId\` in a JSON body. Circle ids are in
the "circles" list of GET /api/me.

## Examples

Replace $TOKEN with the token. Replace ID with an id from a response.

1. Who am I, and who is free?

    curl -H "Authorization: Bearer $TOKEN" https://imhangry.app/api/me

   circle.members[] has each friend's status (type "away" or "busy", or null
   for no status). For friends who shared a calendar, add busy or free:

    curl -H "Authorization: Bearer $TOKEN" https://imhangry.app/api/circles/availability

   Optional ?at=<epoch ms>. Never includes event titles.

2. Set a status (type is "away" or "busy"; text, place and untilDay are
   optional; untilDay is a YYYY-MM-DD date in Europe/Berlin). Then clear it:

    curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
      -d '{"type":"busy","text":"Deep work","untilDay":"2026-07-01"}' \\
      https://imhangry.app/api/me/status

    curl -X DELETE -H "Authorization: Bearer $TOKEN" https://imhangry.app/api/me/status

3. Start a social (free now) and make a plan:

    curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
      -d '{"note":"Coffee?","place":"Cafe Central"}' \\
      https://imhangry.app/api/socials

    curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
      -d '{"note":"Dinner","date":"2026-07-01","time":"19:30"}' \\
      https://imhangry.app/api/plans

   Notes are at most 80 characters. A plan needs a note; date and time are optional.

4. Say I'm in. List what is open, then join:

    curl -H "Authorization: Bearer $TOKEN" https://imhangry.app/api/socials
    curl -X POST -H "Authorization: Bearer $TOKEN" https://imhangry.app/api/socials/ID/join
    curl -X POST -H "Authorization: Bearer $TOKEN" https://imhangry.app/api/plans/ID/join

   To answer with in, maybe or can't, POST /api/socials/ID/reply or
   /api/plans/ID/reply with {"reply":"maybe"}. To back out, POST .../leave.
   Add ?all=1 to GET /api/socials or /api/plans to list every circle.

## Other

GET /api/notifications lists alerts for the current circle.
Errors are JSON: {"error":"..."}. A 429 has a Retry-After header.
`;
