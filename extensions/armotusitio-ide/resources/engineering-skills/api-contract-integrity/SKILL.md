---
name: api-contract-integrity
description: Detect drift across HTTP handlers, OpenAPI, DTOs, clients, and authorization.
---

# API contract integrity

Keep the externally observable API aligned with its authoritative specification and real consumers.

## When to apply

Use for changes to routes, HTTP semantics, DTOs, validation, authentication requirements, authorization, versioning, errors, or client generation. Do not impose OpenAPI on a project that deliberately uses another contract format. Internal refactoring with unchanged wire behavior needs compatibility evidence rather than a new specification.

Minimum inputs are the old and new endpoint behavior, canonical contract location, affected clients, validation and error mapping, and repository generation or compatibility commands. Find the existing owner before creating a contract artifact. If ownership is unclear, record the uncertainty and avoid a competing source of truth.

## Trace the contract

1. Follow the request from routing through authentication, authorization, input decoding, validation, application behavior, persistence effects, and response mapping. Compare both successful and rejected paths.
1. Compare implementation, OpenAPI or equivalent, DTOs, client types, and existing consumer assumptions. Check requiredness, nullability, defaulting, enum values, field names, units, precision, ordering, pagination, and content types.
1. Identify directional compatibility: new server with old client, old server with new client, and mixed-version deployment when supported. A schema addition is not automatically compatible if clients reject unknown fields or exhaustive enum values.
1. Update the canonical source and run the existing generator. Review the generated diff; do not patch generated clients by hand to hide drift.
1. Execute focused producer and consumer checks, including authentication failures, forbidden access, invalid input, and stable machine-readable errors.

## Breaking-change decisions

- Removed or renamed fields, newly required inputs, narrowed accepted values, changed status codes, and altered error meanings require explicit compatibility treatment.
- Widening an output enum or changing numeric representation can break consumers even when the server remains tolerant.
- Changing filters, sort order, cursor semantics, idempotency keys, retry behavior, or authorization is observable behavior beyond schema shape.
- Preserve persistence model boundaries; an internal field must not appear in a public DTO merely because serialization is convenient.
- For asynchronous operations, specify acceptance, status, cancellation when supported, and result retrieval. Do not document a synchronous success response that the implementation cannot deliver.
- Reuse existing deprecation and versioning policy. Do not silently introduce a new API version or migration as part of a small fix.

## Examples and counterexamples

A field changes from optional to required. Existing consumers omit it, so the new server rejects previously valid requests. Preserve a compatible default or stage a versioned migration with explicit authorization; test an old request fixture against the new handler.

An implementation returns a documented forbidden error for a denied actor. Renaming an internal variable is not a contract change. Avoid unrelated schema churn. Conversely, matching generated types does not prove authorization: test the actual backend denial path and ensure no side effect occurred.

## Evidence and output

Use the project's schema validator, generation check, compatibility diff tool, and consumer tests when available. Record unsupported tools as NOT VERIFIED and perform a bounded manual contract comparison without calling it exhaustive certification.

Return a table of changed operations, contract elements, affected consumers, compatibility direction, required fix or rollout order, and verification. Separate pre-existing drift from newly introduced drift. Report remaining unknown consumers and deployment assumptions; do not claim backward compatibility solely because the code compiles.
