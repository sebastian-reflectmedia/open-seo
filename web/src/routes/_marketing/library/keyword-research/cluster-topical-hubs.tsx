import { createFileRoute } from "@tanstack/react-router";
import defaultMdxComponents from "fumadocs-ui/mdx";
import Content, {
  frontmatter,
} from "../../../../../content/marketing/library/cluster-topical-hubs.mdx";
import { LibrarySpokePage } from "@/components/library-page";
import { buildPageSeo } from "@/lib/seo";

const PATH = "/library/keyword-research/cluster-topical-hubs";

export const Route = createFileRoute(
  "/_marketing/library/keyword-research/cluster-topical-hubs",
)({
  head: () =>
    buildPageSeo({
      title:
        "Keyword Clustering: Turn a Keyword List into Topical Hubs (and Fix Cannibalization)",
      description: frontmatter.description,
      path: PATH,
      titleSuffix: "OpenSEO Library",
      ogType: "article",
    }),
  component: () => (
    <LibrarySpokePage
      title={frontmatter.title}
      description={frontmatter.description}
      crumb="Cluster keywords into topical hubs"
      path={PATH}
    >
      <Content components={{ ...defaultMdxComponents }} />
    </LibrarySpokePage>
  ),
});
