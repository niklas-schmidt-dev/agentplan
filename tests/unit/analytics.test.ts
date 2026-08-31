import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyViewer,
  normalizeCountry,
  referrerHost,
  viewRequestContext,
  visitorHash,
} from "@/lib/analytics/views";

describe("classifyViewer", () => {
  const draft = { ownerId: "owner-1" };

  it("classifies the owner", () => {
    expect(classifyViewer(draft, "owner-1")).toBe("owner");
  });

  it("classifies other signed-in users", () => {
    expect(classifyViewer(draft, "someone-else")).toBe("user");
  });

  it("classifies anonymous visitors", () => {
    expect(classifyViewer(draft, null)).toBe("anonymous");
  });
});

describe("visitorHash", () => {
  const previousSecret = process.env.BETTER_AUTH_SECRET;

  beforeEach(() => {
    process.env.BETTER_AUTH_SECRET = "test-secret";
  });

  afterEach(() => {
    if (previousSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = previousSecret;
  });

  it("is stable for the same visitor on the same day", () => {
    const now = new Date("2026-08-31T10:00:00Z");
    const a = visitorHash({ ip: "1.2.3.4", userAgent: "ua" }, now);
    const b = visitorHash({ ip: "1.2.3.4", userAgent: "ua" }, now);
    expect(a).toHaveLength(64);
    expect(a).toBe(b);
  });

  it("rotates across UTC days", () => {
    const visitor = { ip: "1.2.3.4", userAgent: "ua" };
    const monday = visitorHash(visitor, new Date("2026-08-31T23:59:00Z"));
    const tuesday = visitorHash(visitor, new Date("2026-09-01T00:01:00Z"));
    expect(monday).not.toBe(tuesday);
  });

  it("differs between visitors", () => {
    const now = new Date("2026-08-31T10:00:00Z");
    expect(visitorHash({ ip: "1.2.3.4", userAgent: "ua" }, now)).not.toBe(
      visitorHash({ ip: "5.6.7.8", userAgent: "ua" }, now),
    );
  });

  it("returns null without any identifying input", () => {
    expect(visitorHash({ ip: null, userAgent: null })).toBeNull();
  });

  it("returns null without a secret", () => {
    delete process.env.BETTER_AUTH_SECRET;
    expect(visitorHash({ ip: "1.2.3.4", userAgent: "ua" })).toBeNull();
  });
});

describe("referrerHost", () => {
  const previousAppUrl = process.env.NEXT_PUBLIC_APP_URL;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = "https://plans.example.com";
  });

  afterEach(() => {
    if (previousAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = previousAppUrl;
  });

  it("extracts the lowercased host", () => {
    expect(referrerHost("https://News.Ycombinator.com/item?id=1")).toBe("news.ycombinator.com");
  });

  it("keeps the port as part of the host", () => {
    expect(referrerHost("http://example.com:8080/page")).toBe("example.com:8080");
  });

  it("drops self-referrals from our own app host", () => {
    expect(referrerHost("https://plans.example.com/dashboard")).toBeNull();
  });

  it("rejects unparsable or non-http values", () => {
    expect(referrerHost(null)).toBeNull();
    expect(referrerHost("not a url")).toBeNull();
    expect(referrerHost("ftp://example.com/file")).toBeNull();
  });
});

describe("normalizeCountry", () => {
  it("uppercases valid ISO codes", () => {
    expect(normalizeCountry("de")).toBe("DE");
  });

  it("rejects anything but two letters", () => {
    expect(normalizeCountry(null)).toBeNull();
    expect(normalizeCountry("")).toBeNull();
    expect(normalizeCountry("DEU")).toBeNull();
    expect(normalizeCountry("1A")).toBeNull();
  });
});

describe("viewRequestContext", () => {
  it("takes the first x-forwarded-for hop and trims values", () => {
    const context = viewRequestContext(
      new Headers({
        "x-forwarded-for": " 9.9.9.9 , 10.0.0.1",
        "user-agent": " agent ",
        referer: "https://example.com/",
        "x-vercel-ip-country": "DE",
      }),
    );
    expect(context).toEqual({
      ip: "9.9.9.9",
      userAgent: "agent",
      referer: "https://example.com/",
      country: "DE",
    });
  });

  it("returns nulls when headers are absent", () => {
    expect(viewRequestContext(new Headers())).toEqual({
      ip: null,
      userAgent: null,
      referer: null,
      country: null,
    });
  });
});
