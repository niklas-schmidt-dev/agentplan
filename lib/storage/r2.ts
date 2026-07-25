import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ObjectStorage } from "./index";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export class R2Storage implements ObjectStorage {
  private client: S3Client | undefined;
  private bucket = "";

  private getClient(): S3Client {
    if (!this.client) {
      const accountId = requireEnv("R2_ACCOUNT_ID");
      this.bucket = requireEnv("R2_BUCKET");
      this.client = new S3Client({
        region: "auto",
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
          secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
        },
      });
    }
    return this.client;
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.getClient().send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async putIfAbsent(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.getClient().send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        IfNoneMatch: "*",
      }),
    );
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const result = await this.getClient().send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!result.Body) return null;
      return await result.Body.transformToByteArray();
    } catch (error) {
      if (error instanceof Error && error.name === "NoSuchKey") return null;
      throw error;
    }
  }

  async createUploadTarget(input: {
    key: string;
    contentType: string;
    sizeBytes: number;
    expiresAt: Date;
  }) {
    const url = await getSignedUrl(
      this.getClient(),
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        ContentType: input.contentType,
        ContentLength: input.sizeBytes,
        IfNoneMatch: "*",
      }),
      { expiresIn: Math.max(1, Math.floor((input.expiresAt.getTime() - Date.now()) / 1000)) },
    );
    return {
      method: "PUT" as const,
      url,
      headers: {
        "content-type": input.contentType,
        "if-none-match": "*",
      },
    };
  }

  async head(key: string) {
    try {
      const result = await this.getClient().send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        size: result.ContentLength ?? 0,
        contentType: result.ContentType ?? null,
        etag: result.ETag ?? null,
      };
    } catch (error) {
      if (error instanceof Error && (error.name === "NotFound" || error.name === "NoSuchKey")) {
        return null;
      }
      throw error;
    }
  }

  async open(key: string, range?: { start: number; end: number }) {
    try {
      const result = await this.getClient().send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Range: range ? `bytes=${range.start}-${range.end}` : undefined,
        }),
      );
      if (!result.Body) return null;
      return {
        size: result.ContentLength ?? 0,
        contentType: result.ContentType ?? null,
        etag: result.ETag ?? null,
        body: result.Body.transformToWebStream(),
        contentRange: result.ContentRange ?? null,
      };
    } catch (error) {
      if (error instanceof Error && (error.name === "NoSuchKey" || error.name === "NotFound")) {
        return null;
      }
      throw error;
    }
  }

  async copy(sourceKey: string, destinationKey: string, contentType: string): Promise<void> {
    const copySource = `${this.bucket}/${sourceKey.split("/").map(encodeURIComponent).join("/")}`;
    await this.getClient().send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        Key: destinationKey,
        CopySource: copySource,
        ContentType: contentType,
        MetadataDirective: "REPLACE",
        IfNoneMatch: "*",
      }),
    );
  }

  async delete(key: string): Promise<void> {
    await this.getClient().send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
