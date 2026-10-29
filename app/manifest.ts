import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Charla",
    short_name: "Charla",
    description: "Compañera de conversación por voz.",
    start_url: "/",
    display: "fullscreen",
    background_color: "#1C140C",
    theme_color: "#1C140C",
    lang: "es-UY",
  };
}
