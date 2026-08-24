import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import AppShell from './components/shell/AppShell';
import LoginPage from './pages/LoginPage';
import ProjectListPage from './pages/ProjectListPage';
import ProjectOverviewPage from './pages/ProjectOverviewPage';
import ArchitecturePage from './pages/ArchitecturePage';
import ArchitectPage from './pages/ArchitectPage';
import RequirementsPage from './pages/RequirementsPage';
import WorkItemsPage from './pages/WorkItemsPage';
import WorkItemPage from './pages/WorkItemPage';
import ActivityPage from './pages/ActivityPage';
import SettingsPage from './pages/SettingsPage';
import IntegrationsPage from './pages/IntegrationsPage';
import ProviderSettingsPage from './pages/ProviderSettingsPage';
import CompanionHandoffPage from './pages/CompanionHandoffPage';
import BenchmarkListPage from './pages/BenchmarkListPage';
import BenchmarkCreatePage from './pages/BenchmarkCreatePage';
import BenchmarkDetailPage from './pages/BenchmarkDetailPage';
import BenchmarkComparisonPage from './pages/BenchmarkComparisonPage';
import BenchmarkTrialPage from './pages/BenchmarkTrialPage';
import ExecutionPreferencesPage from './pages/ExecutionPreferencesPage';

export default function App() {
  const { hasApiKey } = useAuth();

  if (!hasApiKey) {
    return (
      <Routes>
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/" element={<ProjectListPage />} />
      {/* WORK-028: Companion handoff bridge page (fragment-only deep link). */}
      <Route path="/companion/handoff" element={<CompanionHandoffPage />} />
      <Route path="/projects" element={<ProjectListPage />} />
      <Route
        path="/projects/:projectId"
        element={
          <AppShell>
            <ProjectOverviewPage />
          </AppShell>
        }
      />
      <Route
        path="/projects/:projectId/architect"
        element={
          <AppShell>
            <ArchitectPage />
          </AppShell>
        }
      />
      <Route
        path="/projects/:projectId/architecture"
        element={
          <AppShell>
            <ArchitecturePage />
          </AppShell>
        }
      />
      <Route
        path="/projects/:projectId/requirements"
        element={
          <AppShell>
            <RequirementsPage />
          </AppShell>
        }
      />
      <Route
        path="/projects/:projectId/work-items"
        element={
          <AppShell>
            <WorkItemsPage />
          </AppShell>
        }
      />
      <Route
        path="/work-items/:workItemId"
        element={
          <AppShell>
            <WorkItemPage />
          </AppShell>
        }
      />
      <Route
        path="/projects/:projectId/activity"
        element={
          <AppShell>
            <ActivityPage />
          </AppShell>
        }
      />
      <Route
        path="/projects/:projectId/settings"
        element={
          <AppShell>
            <SettingsPage />
          </AppShell>
        }
      />
      {/* WORK-033: Execution policy + user preferences + access profiles. */}
      <Route
        path="/projects/:projectId/settings/execution"
        element={
          <AppShell>
            <ExecutionPreferencesPage />
          </AppShell>
        }
      />
      <Route
        path="/projects/:projectId/integrations"
        element={
          <AppShell>
            <IntegrationsPage />
          </AppShell>
        }
      />
      <Route
        path="/settings/providers"
        element={
          <AppShell>
            <ProviderSettingsPage />
          </AppShell>
        }
      />
      {/* WORK-032: Native vs External Execution Benchmark. Top-level
          (non-project) routes wrapped in AppShell for the persistent frame. */}
      <Route
        path="/benchmarks"
        element={
          <AppShell>
            <BenchmarkListPage />
          </AppShell>
        }
      />
      <Route
        path="/benchmarks/new"
        element={
          <AppShell>
            <BenchmarkCreatePage />
          </AppShell>
        }
      />
      <Route
        path="/benchmarks/:benchmarkId"
        element={
          <AppShell>
            <BenchmarkDetailPage />
          </AppShell>
        }
      />
      <Route
        path="/benchmarks/:benchmarkId/compare"
        element={
          <AppShell>
            <BenchmarkComparisonPage />
          </AppShell>
        }
      />
      <Route
        path="/benchmarks/trials/:trialId"
        element={
          <AppShell>
            <BenchmarkTrialPage />
          </AppShell>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
