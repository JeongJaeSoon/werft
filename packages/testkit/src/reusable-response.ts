// A scripted Response may be served more than once, so hand out a copy and
// keep the original body unread.
export function reusable(response: Response): Response {
  const copy = response.clone();
  return new Response(copy.body, {
    headers: copy.headers,
    status: copy.status,
    statusText: copy.statusText,
  });
}
