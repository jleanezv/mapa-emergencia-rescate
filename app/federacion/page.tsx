import type { Metadata } from "next";
import FederationUploadForm from "@/app/components/FederationUploadForm";
import SubPageShell from "@/app/components/SubPageShell";

export const metadata: Metadata = {
  title: "Federación de datos · Mapa de Emergencia Venezuela",
  alternates: { canonical: "/federacion" },
  description:
    "Sube archivos, fotos, listas o JSON público para que Respuesta VE los procese en la cola humanitaria central.",
};

export default function FederacionPage() {
  return (
    <SubPageShell breadcrumb="Federación de datos">
      <FederationUploadForm />
    </SubPageShell>
  );
}
