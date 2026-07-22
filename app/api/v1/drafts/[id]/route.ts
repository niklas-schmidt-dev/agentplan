import { getDraftForOwner, getVersionById } from "@/db/queries/drafts";
import { authenticateApiRequest, isFailure, type ApiActor } from "@/lib/api/auth";
import {
  insufficientScope,
  internalError,
  invalidRequest,
  notFound,
  unauthorized,
} from "@/lib/api/responses";
import { serializeDraft } from "@/lib/api/serialize";
import {
  DraftNotFoundError,
  PasswordRequiredError,
  PasswordVisibilityConflictError,
  setDraftPassword,
  setDraftTitle,
  setDraftVisibility,
  softDeleteDraft,
} from "@/lib/drafts/service";
import { patchDraftSchema, uuidSchema } from "@/lib/validation/api";
import type { Draft } from "@/db/schema";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

async function currentVersionNumber(draft: Draft): Promise<number | null> {
  if (!draft.currentVersionId) return null;
  const version = await getVersionById(draft.id, draft.currentVersionId);
  return version?.versionNumber ?? null;
}

/** Owner-scoped fetch; invalid UUIDs and other users' drafts both read as 404. */
async function loadOwnedDraft(actor: ApiActor, rawId: string): Promise<Draft | null> {
  const id = uuidSchema.safeParse(rawId);
  if (!id.success) return null;
  return getDraftForOwner(id.data, actor.userId);
}

export async function GET(req: Request, { params }: Params): Promise<Response> {
  const actor = await authenticateApiRequest(req, "drafts:read");
  if (isFailure(actor)) {
    return actor.failure === "scope" ? insufficientScope(actor.scope) : unauthorized();
  }
  const draft = await loadOwnedDraft(actor, (await params).id);
  if (!draft) return notFound();
  return Response.json({ draft: serializeDraft(draft, await currentVersionNumber(draft)) });
}

export async function PATCH(req: Request, { params }: Params): Promise<Response> {
  const actor = await authenticateApiRequest(req, "drafts:write");
  if (isFailure(actor)) {
    return actor.failure === "scope" ? insufficientScope(actor.scope) : unauthorized();
  }
  const draft = await loadOwnedDraft(actor, (await params).id);
  if (!draft) return notFound();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return invalidRequest("Expected a JSON body.");
  }
  const patch = patchDraftSchema.safeParse(body);
  if (!patch.success) {
    return invalidRequest(patch.error.issues[0]?.message ?? "Invalid body.");
  }
  // Validate the only state-dependent password precondition before applying
  // any field, so a rejected multi-field PATCH cannot persist a partial title.
  if (
    patch.data.visibility === "password" &&
    patch.data.password === undefined &&
    !draft.passwordHash
  ) {
    return invalidRequest("A password is required for password-protected drafts.");
  }

  try {
    const tokenId = actor.kind === "token" ? actor.tokenId : undefined;
    const who = { userId: actor.userId, tokenId };
    let updated = draft;
    if (patch.data.visibility !== undefined) {
      // Handles the password requirement and clears the hash when leaving password mode.
      updated = await setDraftVisibility(updated, patch.data.visibility, who, patch.data.password);
    } else if (patch.data.password !== undefined) {
      // A password with no visibility change means: set/rotate the password
      // (which also makes the draft password-protected).
      updated = await setDraftPassword(updated, patch.data.password, who);
    }
    if (patch.data.title !== undefined) {
      updated = await setDraftTitle(updated, patch.data.title, who);
    }
    return Response.json({ draft: serializeDraft(updated, await currentVersionNumber(updated)) });
  } catch (error) {
    if (error instanceof PasswordRequiredError) {
      return invalidRequest("A password is required for password-protected drafts.");
    }
    if (error instanceof PasswordVisibilityConflictError) {
      return invalidRequest("A password cannot be combined with public or private visibility.");
    }
    if (error instanceof DraftNotFoundError) return notFound();
    console.error("PATCH /api/v1/drafts/:id failed", error);
    return internalError();
  }
}

export async function DELETE(req: Request, { params }: Params): Promise<Response> {
  const actor = await authenticateApiRequest(req, "drafts:write");
  if (isFailure(actor)) {
    return actor.failure === "scope" ? insufficientScope(actor.scope) : unauthorized();
  }
  const draft = await loadOwnedDraft(actor, (await params).id);
  if (!draft) return notFound();

  await softDeleteDraft(draft, {
    userId: actor.userId,
    tokenId: actor.kind === "token" ? actor.tokenId : undefined,
  });
  return new Response(null, { status: 204 });
}
