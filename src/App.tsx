import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/contexts/AuthContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import Auth from "./pages/Auth";
import Profile from "./pages/Profile";
import AdminUsers from "./pages/AdminUsers";
import Dashboard from "./pages/Dashboard";
import Reports from "./pages/Reports";
import ReportDetail from "./pages/ReportDetail";
import ScenarioDetail from "./pages/ScenarioDetail";
import Scenarios from "./pages/Scenarios";
import Runs from "./pages/Runs";
import Checks from "./pages/Checks";
import RunDetail from "./pages/RunDetail";
import SqlTemplates from "./pages/SqlTemplates";
import SettingsPage from "./pages/Settings";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      refetchOnMount: false,
      refetchOnReconnect: false,
      staleTime: 30_000,
    },
  },
});

const App = () => (
  <QueryClientProvider client={queryClient}>
    <ThemeProvider>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route path="/auth" element={<Auth />} />
            <Route path="/" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
            <Route path="/reports" element={<ProtectedRoute><Reports /></ProtectedRoute>} />
            <Route path="/reports/:id" element={<ProtectedRoute><ReportDetail /></ProtectedRoute>} />
            <Route path="/scenarios" element={<ProtectedRoute><Scenarios /></ProtectedRoute>} />
            <Route path="/scenarios/:id" element={<ProtectedRoute><ScenarioDetail /></ProtectedRoute>} />
            <Route path="/runs" element={<ProtectedRoute><Runs /></ProtectedRoute>} />
            <Route path="/runs/:id" element={<ProtectedRoute><RunDetail /></ProtectedRoute>} />
            <Route path="/checks" element={<ProtectedRoute><Checks /></ProtectedRoute>} />
            <Route path="/tests" element={<Navigate to="/scenarios" replace />} />
            <Route path="/sql-templates" element={<ProtectedRoute><SqlTemplates /></ProtectedRoute>} />
            <Route path="/profile" element={<ProtectedRoute><Profile /></ProtectedRoute>} />
            <Route path="/admin/users" element={<ProtectedRoute adminOnly><AdminUsers /></ProtectedRoute>} />
            <Route path="/settings" element={<ProtectedRoute adminOnly><SettingsPage /></ProtectedRoute>} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
    </ThemeProvider>
  </QueryClientProvider>
);

export default App;
