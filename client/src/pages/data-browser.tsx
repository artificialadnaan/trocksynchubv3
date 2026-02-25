import { useState } from "react";
import { Database, Camera, HardHat } from "lucide-react";
import { HubspotDataContent } from "./hubspot-data";
import { ProcoreDataContent } from "./procore-data";
import { CompanyCamDataContent } from "./companycam-data";
import { cn } from "@/lib/utils";

type Platform = "hubspot" | "procore" | "companycam";

const platforms: { id: Platform; label: string; icon: typeof Database }[] = [
  { id: "hubspot", label: "HubSpot", icon: Database },
  { id: "procore", label: "Procore", icon: HardHat },
  { id: "companycam", label: "CompanyCam", icon: Camera },
];

export default function DataBrowserPage() {
  const [activePlatform, setActivePlatform] = useState<Platform>("hubspot");

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold flex items-center gap-2" data-testid="text-data-browser-title">
          <Database className="w-6 h-6" />
          Data Browser
        </h2>
        <p className="text-muted-foreground text-sm mt-1">
          Browse synced data across all platforms with 2-week change history
        </p>
      </div>

      <div className="flex gap-1 bg-muted p-1 rounded-lg w-fit">
        {platforms.map((platform) => (
          <button
            key={platform.id}
            onClick={() => setActivePlatform(platform.id)}
            className={cn(
              "flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md transition-all",
              activePlatform === platform.id
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
            data-testid={`tab-platform-${platform.id}`}
          >
            <platform.icon className="w-4 h-4" />
            {platform.label}
          </button>
        ))}
      </div>

      {activePlatform === "hubspot" && <HubspotDataContent />}
      {activePlatform === "procore" && <ProcoreDataContent />}
      {activePlatform === "companycam" && <CompanyCamDataContent />}
    </div>
  );
}
