import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";

const MAX_BODY_BYTES = 1024 * 1024;
const PROFILE_ENV = "PAPERCLIP_TYPESAFE_WORKER_TRANSPORT";
type Profile = { baseURL: string; addresses: string[]; caPem: string | null };
function denied(): Error { return new Error("TypeSafe transport request denied"); }
function parseProfile(raw: string | undefined): Profile {
  if (!raw || raw.length > 96 * 1024) throw denied();
  let value: Profile;
  try { value = JSON.parse(raw); } catch { throw denied(); }
  if (!value || typeof value !== "object" || Object.keys(value).some((key) => !["baseURL", "addresses", "caPem"].includes(key))) throw denied();
  let url: URL;
  try { url = new URL(value.baseURL); } catch { throw denied(); }
  if (url.protocol !== "https:" || url.origin !== value.baseURL || url.username || url.password
    || !Array.isArray(value.addresses) || !value.addresses.length || value.addresses.length > 32
    || value.addresses.some((address) => typeof address !== "string" || !isIP(address))
    || (value.caPem !== null && (typeof value.caPem !== "string" || value.caPem.length > 64 * 1024))) throw denied();
  return value;
}

/** A plugin-local fetch. Only the host loader can provide its profile. No global TLS settings. */
export function operatorTransportOptions(raw = process.env[PROFILE_ENV]): { baseURL: string; fetch: typeof fetch } {
  const profile = parseProfile(raw);
  const origin = new URL(profile.baseURL);
  const addresses = profile.addresses.map((address) => ({ address, family: isIP(address) }));
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    // Do not follow redirects, accept arbitrary API paths, or let SDK/environment
    // configuration replace the operator-approved origin or HTTP authority.
    if (url.origin !== origin.origin || url.username || url.password || url.search || url.hash
      || url.pathname !== "/v1/systemone" || request.method !== "POST") throw denied();
    const bytes = Buffer.from(await request.arrayBuffer());
    if (bytes.length > MAX_BODY_BYTES) throw denied();
    if (request.signal.aborted) throw new DOMException("Aborted", "AbortError");
    return await new Promise<Response>((resolve, reject) => {
      const headers: Record<string, string> = {};
      request.headers.forEach((value, name) => { headers[name] = value; });
      headers.host = url.host;
      headers["accept-encoding"] = "identity";
      const options: RequestOptions = {
        method: "POST", headers, agent: false, servername: url.hostname, rejectUnauthorized: true,
        ...(profile.caPem ? { ca: profile.caPem } : {}),
        // Host-approved DNS results are used directly. No second resolution can
        // turn a checked public address into a private/metadata destination.
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, addresses);
          else callback(null, addresses[0]!.address, addresses[0]!.family);
        },
      };
      const req = httpsRequest(url, options, (res) => {
        if ((res.statusCode ?? 0) >= 300 && (res.statusCode ?? 0) < 400) {
          res.destroy(); reject(denied()); return;
        }
        const chunks: Buffer[] = []; let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_BODY_BYTES) { res.destroy(); reject(denied()); return; }
          chunks.push(chunk);
        });
        res.on("error", () => reject(new Error("TypeSafe transport response failed")));
        res.on("end", () => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
          }
          try {
            const status = res.statusCode ?? 502;
            resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers: responseHeaders }));
          } catch { reject(new Error("TypeSafe transport response failed")); }
        });
      });
      req.on("socket", (socket) => socket.once("secureConnect", () => {
        const peer = socket.remoteAddress?.replace(/^::ffff:/, "");
        if (!profile.addresses.some((address) => peer === address.replace(/^::ffff:/, ""))) req.destroy(denied());
      }));
      const abort = () => req.destroy(new DOMException("Aborted", "AbortError"));
      request.signal.addEventListener("abort", abort, { once: true });
      req.on("close", () => request.signal.removeEventListener("abort", abort));
      // Preserve abort identity for the SDK; other failures contain no request,
      // credential, response body, URL or certificate data.
      req.on("error", (error) => reject(error.name === "AbortError" ? error : new Error("TypeSafe transport connection failed")));
      if (request.signal.aborted) abort();
      else req.end(bytes);
    });
  };
  return { baseURL: profile.baseURL, fetch: transport };
}
