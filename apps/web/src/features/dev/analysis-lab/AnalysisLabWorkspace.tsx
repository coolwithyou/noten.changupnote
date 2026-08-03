"use client";

import { FileCheck2, Gauge, SearchCheck } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AnalysisLab } from "./AnalysisLab";
import { ApplicationRoundtripLab } from "./ApplicationRoundtripLab";
import { BatchOpsTab } from "./BatchOpsTab";

export function AnalysisLabWorkspace() {
  return (
    <Tabs defaultValue="criteria" className="min-h-screen gap-0">
      <div className="sticky top-0 z-30 border-b border-border bg-background/95 px-4 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center py-2">
          <TabsList variant="line" className="h-10">
            <TabsTrigger value="criteria" className="px-3">
              <SearchCheck data-icon="inline-start" />
              공고 조건 딥분석
            </TabsTrigger>
            <TabsTrigger value="application-roundtrip" className="px-3">
              <FileCheck2 data-icon="inline-start" />
              지원서 왕복 실험
            </TabsTrigger>
            <TabsTrigger value="batch-ops" className="px-3">
              <Gauge data-icon="inline-start" />
              배치 운영
            </TabsTrigger>
          </TabsList>
        </div>
      </div>
      <TabsContent value="criteria"><AnalysisLab /></TabsContent>
      <TabsContent value="application-roundtrip"><ApplicationRoundtripLab /></TabsContent>
      <TabsContent value="batch-ops"><BatchOpsTab /></TabsContent>
    </Tabs>
  );
}
