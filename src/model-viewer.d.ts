/**
 * Type augmentation for Google's `<model-viewer>` web component.
 *
 * The component is loaded as an ES module from the Google CDN
 * (`https://ajax.googleapis.com/ajax/libs/model-viewer/...`) at runtime via
 * `next/script`. Because it's a web component, React/TS need an explicit
 * IntrinsicElements entry for the `<model-viewer>` tag to type-check inside
 * JSX.
 *
 * Only the props we actually use are typed — extend this interface if more
 * `<model-viewer>` attributes are needed elsewhere.
 *
 * In React 19 the JSX namespace lives at `React.JSX`, not in the global
 * `JSX` namespace. We augment both forms so the tag types correctly under
 * either resolution path.
 *
 * See https://modelviewer.dev/docs/index.html for the full attribute set.
 */

import type { DetailedHTMLProps, HTMLAttributes } from "react";

type ModelViewerElement = DetailedHTMLProps<
  HTMLAttributes<HTMLElement> & {
    src?: string;
    alt?: string;
    poster?: string;
    ar?: boolean | "";
    "auto-rotate"?: boolean | "";
    "camera-controls"?: boolean | "";
    "shadow-intensity"?: string;
    "environment-image"?: string;
    exposure?: string;
    loading?: "auto" | "lazy" | "eager";
    reveal?: "auto" | "manual";
  },
  HTMLElement
>;

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "model-viewer": ModelViewerElement;
    }
  }
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "model-viewer": ModelViewerElement;
    }
  }
}

export {};
