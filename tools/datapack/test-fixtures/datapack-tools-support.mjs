import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { sha256 } from "../../lib/hash.mjs";

export const execFileAsync = promisify(execFile);

export function objectStorageEnv(origin) {
  return {
    ...process.env,
    EASYSUBWAY_OBJECT_STORAGE_ENDPOINT: origin,
    EASYSUBWAY_DATAPACK_BUCKET: "easysubway-datapacks",
    EASYSUBWAY_OBJECT_STORAGE_REGION: "ap-northeast-2",
    EASYSUBWAY_OBJECT_STORAGE_ACCESS_KEY: "test-access-key",
    EASYSUBWAY_OBJECT_STORAGE_SECRET_KEY: "test-secret-key",
  };
}

export async function startObjectStorageServer({ requireAuthorization = true, basePath = "/easysubway-datapacks" } = {}) {
  const requests = [];
  const objects = new Map();
  const server = createServer(async (request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(request.url, "http://127.0.0.1");
      const normalizedBasePath = basePath.replace(/\/+$/, "");
      const key = decodeURIComponent(url.pathname.replace(new RegExp(`^${escapeRegExp(normalizedBasePath)}\\/?`), ""));
      requests.push({
        method: request.method,
        path: url.pathname,
        authorization: request.headers.authorization,
        contentSha256: request.headers["x-amz-content-sha256"],
      });

      if (requireAuthorization && !request.headers.authorization) {
        response.writeHead(403);
        response.end("missing authorization");
        return;
      }

      if (request.method === "PUT") {
        objects.set(key, {
          body,
          sha256: sha256(body),
          sizeBytes: body.length,
          contentType: request.headers["content-type"],
          metadataSha256: request.headers["x-amz-meta-sha256"],
          cacheControl: request.headers["cache-control"],
        });
        response.writeHead(200, { etag: `"${sha256(body).slice(0, 32)}"` });
        response.end();
        return;
      }

      if (request.method === "HEAD") {
        const object = objects.get(key);
        if (!object) {
          response.writeHead(404);
          response.end();
          return;
        }
        const headers = {
          "content-length": String(object.sizeBytes),
          "x-amz-meta-sha256": object.metadataSha256,
        };
        if (object.cacheControl !== undefined) {
          headers["cache-control"] = object.cacheControl;
        }
        response.writeHead(200, headers);
        response.end();
        return;
      }

      if (request.method === "GET") {
        const object = objects.get(key);
        if (!object) {
          response.writeHead(404);
          response.end();
          return;
        }
        const headers = { "content-length": String(object.sizeBytes) };
        if (object.cacheControl !== undefined) {
          headers["cache-control"] = object.cacheControl;
        }
        response.writeHead(200, headers);
        response.end(object.body);
        return;
      }

      response.writeHead(405);
      response.end("method not allowed");
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    objects,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
