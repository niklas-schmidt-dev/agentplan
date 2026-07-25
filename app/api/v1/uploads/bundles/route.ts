import { z } from "zod";
import { authenticateApiRequest, isFailure } from "@/lib/api/auth";
import { insufficientScope, invalidRequest, unauthorized } from "@/lib/api/responses";
import { consumeUploadRateLimit } from "@/lib/limits/enforce";
import { createBundleUpload } from "@/lib/uploads/bundles";
import { listPendingUploadIntents } from "@/lib/uploads/service";
import { uploadErrorResponse } from "@/lib/uploads/responses";

export const runtime = "nodejs";
export const maxDuration = 300;

const targetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("new"),
    title: z.string().max(200).optional(),
    visibility: z.enum(["public", "private", "password"]).default("private"),
    password: z.string().min(6).max(128).optional(),
  }),
  z.object({ type: z.literal("draft"), draftId: z.uuid() }),
]);

const createSchema = z.object({
  entryPath: z.string().min(1).max(512),
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(512),
        contentType: z.string().min(1).max(100),
        sizeBytes: z.number().int().positive(),
      }),
    )
    .min(1)
    .max(51),
  target: targetSchema,
});

export async function POST(req: Request): Promise<Response> {
  const actor = await authenticateApiRequest(req, "drafts:write");
  if (isFailure(actor)) {
    return actor.failure === "scope" ? insufficientScope(actor.scope) : unauthorized();
  }
  let input: z.infer<typeof createSchema>;
  try {
    const parsed = createSchema.safeParse(await req.json());
    if (!parsed.success) {
      return invalidRequest(parsed.error.issues[0]?.message ?? "Invalid bundle.");
    }
    input = parsed.data;
  } catch {
    return invalidRequest("Expected a JSON bundle request.");
  }
  try {
    await consumeUploadRateLimit(actor.userId);
    const result = await createBundleUpload({
      ownerId: actor.userId,
      source: actor.kind === "token" ? "api_token" : "browser",
      tokenId: actor.kind === "token" ? actor.tokenId : undefined,
      entryPath: input.entryPath,
      files: input.files,
      target: input.target,
    });
    return Response.json(
      {
        intent: {
          id: result.intent.id,
          status: result.intent.status,
          expiresAt: result.intent.expiresAt.toISOString(),
        },
        files: result.files,
        quota: result.quota,
      },
      { status: 201 },
    );
  } catch (error) {
    return uploadErrorResponse(error);
  }
}

export async function GET(req: Request): Promise<Response> {
  const actor = await authenticateApiRequest(req, "drafts:write");
  if (isFailure(actor)) {
    return actor.failure === "scope" ? insufficientScope(actor.scope) : unauthorized();
  }
  const intents = (await listPendingUploadIntents(actor.userId)).filter(
    (intent) => intent.mode === "bundle",
  );
  return Response.json({
    bundles: intents.map((intent) => ({
      id: intent.id,
      entryPath: intent.entryPath,
      filename: intent.originalFilename,
      fileCount: intent.fileCount,
      reservedBytes: intent.expectedBytes,
      expiresAt: intent.expiresAt.toISOString(),
      status: intent.status,
    })),
  });
}
