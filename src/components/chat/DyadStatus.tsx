import React from "react";
import { Loader2 } from "lucide-react";
import { CustomTagState } from "./stateTypes";

interface DyadStatusProps {
  node?: {
    properties: {
      agent: string;
      state: CustomTagState;
    };
  };
  children?: React.ReactNode;
}

export const DyadStatus: React.FC<DyadStatusProps> = ({ node, children }) => {
  const agent = node?.properties.agent || "Agent";
  const state = node?.properties.state || "finished";

  return (
    <div className="my-2 flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
      {state === "pending" || state === "in-progress" ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <div className="h-2 w-2 rounded-full bg-green-500" />
      )}
      <span className="font-medium">{agent}</span>
      <span>{children}</span>
    </div>
  );
};
