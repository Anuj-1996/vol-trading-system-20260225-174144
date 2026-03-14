// ReportGenerator.jsx
// Independent report pipeline for on-demand research-style PNG export
import React from 'react';

// This component does NOT run any logic unless triggered
export default function ReportGenerator() {
  // No UI, logic is triggered via window.generateReport()
  React.useEffect(() => {
    window.generateReport = async function generateReport() {
      // Dynamically import the report pipeline only when needed
      const { runReportPipeline } = await import('./reportPipeline');
      await runReportPipeline();
    };
    return () => { delete window.generateReport; };
  }, []);
  return null;
}
