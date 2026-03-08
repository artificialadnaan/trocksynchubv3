"use client";

import { Info } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface InfoTooltipProps {
  text: string;
}

export function InfoTooltip({ text }: InfoTooltipProps) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex cursor-help text-muted-foreground">
            <Info className="h-4 w-4" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[220px] text-sm">
          {text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
