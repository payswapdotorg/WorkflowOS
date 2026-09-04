import { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import AppShell from './components/shell/AppShell';
import LoginPage from './pages/LoginPage';
import ProjectListPage from './pages/ProjectListPage';
import ProjectOverviewPage from './pages/ProjectOverviewPage';
import WorkbenchPage from './pages/WorkbenchPage';
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
import UniversalProductShell from './components/shell/UniversalProductShell';
import HomePage from './pages/HomePage';
import WorkflowsPage from './pages/WorkflowsPage';
import ExplorePage from './pages/ExplorePage';
import ProductActivityPage from './pages/ProductActivityPage';
import CreatePage from './pages/CreatePage';
import ExpertPage from './pages/ExpertPage';

export default function App() {
  // WORK-074: the auth gate reads the ONE canonical auth-state source. When a
  // sign-in (or a backend 401) changes the source, this re-renders
  // synchronously — no manual reload (the WORK-072 state-ownership pattern; the
  // backend remains the authorization authority: WORK-022 invariant).
  const { status, refreshSession } = useAuth();

  useEffect(() => {
    // Resolve the session from the backend once at mount (refresh persistence:
    // after a reload a valid session cookie keeps the protected routes visible).
    refreshSession();
  }, [refreshSession]);

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div
          className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent"
          role="status"
          aria-label="Loading"
        />
      </div>
    );
  }

  if (status === 'unauthenticated') {
    return (
      <Routes>
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }

  return (
    <Routes>
      {/* V2-017 Task 1 — the universal product shell. Primary navigation is
          Home / Workflows / Explore / Activity plus the universal Create
          entry; the developer/engineering workspace stays reachable through
          the Expert entry (progressive disclosure, never primary
          navigation). Every existing protected/expert route below is
          unchanged. */}
      <Route
        path="/"
        element={
          <UniversalProductShell>
            <HomePage />
          </UniversalProductShell>
        }
      />
      <Route
        path="/workflows"
        element={
          <UniversalProductShell>
            <WorkflowsPage />
          </UniversalProductShell>
        }
      />
      <Route
        path="/explore"
        element={
          <UniversalProductShell>
            <ExplorePage />
          </UniversalProductShell>
        }
      />
      <Route
        path="/activity"
        element={
          <UniversalProductShell>
            <ProductActivityPage />
          </UniversalProductShell>
        }
      />
      <Route
        path="/create"
        element={
          <UniversalProductShell>
            <CreatePage />
          </UniversalProductShell>
        }
      />
      <Route
        path="/expert"
        element={
          <UniversalProductShell>
            <ExpertPage />
          </UniversalProductShell>
        }
      />
      {/* WORK-028: Companion handoff bridge page (fragment-only deep link). */}
      <Route path="/companion/handoff" element={<CompanionHandoffPage />} />
      {/* The expert-entry target: the existing project list (developer
          workspace) — re-contextualized, not deleted. */}
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
      {/* WORK-048: the Developer Workbench — the primary engineering workspace
          (a consumer of backend authorities; read-only). */}
      <Route
        path="/projects/:projectId/workbench"
        element={
          <AppShell>
            <WorkbenchPage />
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
