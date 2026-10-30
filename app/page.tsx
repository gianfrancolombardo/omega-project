"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

import { CompanionScreen } from "@/components/companion-screen";

function Screen() {
  const params = useSearchParams();
  const estado = params.get("estado");
  if (!estado) return <CompanionScreen mode="live" />;
  return <CompanionScreen mode="preview" preview={estado} previewName={params.get("nombre") ?? undefined} />;
}

export default function Page() {
  return (
    <Suspense fallback={<CompanionScreen mode="preview" preview="reposo" previewName="Elena" />}>
      <Screen />
    </Suspense>
  );
}
