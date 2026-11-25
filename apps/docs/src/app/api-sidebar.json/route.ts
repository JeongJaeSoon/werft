import { type ApiSidebar, mapTagFolders } from "@/lib/api-sidebar";
import { i18n } from "@/lib/i18n";
import { source } from "@/lib/source";

export const revalidate = false;

// The reference is English in every language, so one file serves them all.
export function GET() {
  const lang = i18n.defaultLanguage;
  const sidebar: ApiSidebar = {};
  mapTagFolders(source.getPageTree(lang), lang, (folder, tag) => {
    sidebar[tag] = folder.children.flatMap((node) => {
      if (node.type !== "page") return [];
      const page = source.getNodePage(node, lang);
      if (page?.type !== "openapi") return [];
      const { method, deprecated } = page.data._openapi;
      return [
        {
          title: page.data.title ?? "",
          url: node.url.slice(lang.length + 1),
          ...(method && { method }),
          ...(deprecated && { deprecated }),
        },
      ];
    });
    return folder.children;
  });
  return Response.json(sidebar);
}
