export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      agent_model_config: {
        Row: {
          agent_key: string
          id: string
          llm_provider_id: string | null
          model: string | null
          system_instruction: string | null
          temperature: number | null
        }
        Insert: {
          agent_key: string
          id?: string
          llm_provider_id?: string | null
          model?: string | null
          system_instruction?: string | null
          temperature?: number | null
        }
        Update: {
          agent_key?: string
          id?: string
          llm_provider_id?: string | null
          model?: string | null
          system_instruction?: string | null
          temperature?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_model_config_llm_provider_id_fkey"
            columns: ["llm_provider_id"]
            isOneToOne: false
            referencedRelation: "llm_providers"
            referencedColumns: ["id"]
          },
        ]
      }
      api_tokens: {
        Row: {
          created_at: string
          id: string
          last_used_at: string | null
          name: string
          scopes: Json
          token_hash: string
        }
        Insert: {
          created_at?: string
          id?: string
          last_used_at?: string | null
          name: string
          scopes?: Json
          token_hash: string
        }
        Update: {
          created_at?: string
          id?: string
          last_used_at?: string | null
          name?: string
          scopes?: Json
          token_hash?: string
        }
        Relationships: []
      }
      brands: {
        Row: {
          created_at: string
          id: string
          name: string
          workstream_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          workstream_id: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          workstream_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "brands_workstream_id_fkey"
            columns: ["workstream_id"]
            isOneToOne: false
            referencedRelation: "workstreams"
            referencedColumns: ["id"]
          },
        ]
      }
      browser_runtime: {
        Row: {
          created_at: string
          extra: Json
          id: string
          name: string
          provider: string | null
          ws_endpoint_secret_ref: string | null
        }
        Insert: {
          created_at?: string
          extra?: Json
          id?: string
          name: string
          provider?: string | null
          ws_endpoint_secret_ref?: string | null
        }
        Update: {
          created_at?: string
          extra?: Json
          id?: string
          name?: string
          provider?: string | null
          ws_endpoint_secret_ref?: string | null
        }
        Relationships: []
      }
      credential_profiles: {
        Row: {
          created_at: string
          extra: Json
          id: string
          login_url: string | null
          name: string
          password_secret_ref: string | null
          username: string | null
        }
        Insert: {
          created_at?: string
          extra?: Json
          id?: string
          login_url?: string | null
          name: string
          password_secret_ref?: string | null
          username?: string | null
        }
        Update: {
          created_at?: string
          extra?: Json
          id?: string
          login_url?: string | null
          name?: string
          password_secret_ref?: string | null
          username?: string | null
        }
        Relationships: []
      }
      llm_providers: {
        Row: {
          api_key_secret_ref: string | null
          base_url: string | null
          created_at: string
          extra: Json
          id: string
          kind: string
          model_default: string | null
          name: string
          wrapper_payload_template: string | null
        }
        Insert: {
          api_key_secret_ref?: string | null
          base_url?: string | null
          created_at?: string
          extra?: Json
          id?: string
          kind: string
          model_default?: string | null
          name: string
          wrapper_payload_template?: string | null
        }
        Update: {
          api_key_secret_ref?: string | null
          base_url?: string | null
          created_at?: string
          extra?: Json
          id?: string
          kind?: string
          model_default?: string | null
          name?: string
          wrapper_payload_template?: string | null
        }
        Relationships: []
      }
      note_memory: {
        Row: {
          created_at: string
          decision: string
          id: string
          reason: string | null
          scenario_id: string | null
          signature: string
          weight: number
        }
        Insert: {
          created_at?: string
          decision: string
          id?: string
          reason?: string | null
          scenario_id?: string | null
          signature: string
          weight?: number
        }
        Update: {
          created_at?: string
          decision?: string
          id?: string
          reason?: string | null
          scenario_id?: string | null
          signature?: string
          weight?: number
        }
        Relationships: [
          {
            foreignKeyName: "note_memory_scenario_id_fkey"
            columns: ["scenario_id"]
            isOneToOne: false
            referencedRelation: "scenarios"
            referencedColumns: ["id"]
          },
        ]
      }
      operator_notes: {
        Row: {
          body: string | null
          created_at: string
          id: string
          note_type: string
          scenario_id: string | null
          test_result_id: string | null
        }
        Insert: {
          body?: string | null
          created_at?: string
          id?: string
          note_type: string
          scenario_id?: string | null
          test_result_id?: string | null
        }
        Update: {
          body?: string | null
          created_at?: string
          id?: string
          note_type?: string
          scenario_id?: string | null
          test_result_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "operator_notes_scenario_id_fkey"
            columns: ["scenario_id"]
            isOneToOne: false
            referencedRelation: "scenarios"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "operator_notes_test_result_id_fkey"
            columns: ["test_result_id"]
            isOneToOne: false
            referencedRelation: "test_results"
            referencedColumns: ["id"]
          },
        ]
      }
      playwright_jobs: {
        Row: {
          created_at: string
          finished_at: string | null
          id: string
          last_event: Json | null
          live_url: string | null
          mode: string
          prerun_id: string | null
          scenario_id: string | null
          status: string
        }
        Insert: {
          created_at?: string
          finished_at?: string | null
          id?: string
          last_event?: Json | null
          live_url?: string | null
          mode?: string
          prerun_id?: string | null
          scenario_id?: string | null
          status?: string
        }
        Update: {
          created_at?: string
          finished_at?: string | null
          id?: string
          last_event?: Json | null
          live_url?: string | null
          mode?: string
          prerun_id?: string | null
          scenario_id?: string | null
          status?: string
        }
        Relationships: []
      }
      prerun_scripts: {
        Row: {
          created_at: string
          id: string
          name: string
          playwright_code: string | null
          report_id: string
          steps: Json
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          playwright_code?: string | null
          report_id: string
          steps?: Json
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          playwright_code?: string | null
          report_id?: string
          steps?: Json
        }
        Relationships: []
      }
      reports: {
        Row: {
          brand_id: string | null
          created_at: string
          credential_profile_id: string | null
          default_sql_template_id: string | null
          id: string
          kpi_config: Json
          name: string
          reference_credential_profile_id: string | null
          reference_url: string | null
          schedule_cron: string | null
          url: string
          warehouse_connector_id: string | null
          workstream_id: string
        }
        Insert: {
          brand_id?: string | null
          created_at?: string
          credential_profile_id?: string | null
          default_sql_template_id?: string | null
          id?: string
          kpi_config?: Json
          name: string
          reference_credential_profile_id?: string | null
          reference_url?: string | null
          schedule_cron?: string | null
          url: string
          warehouse_connector_id?: string | null
          workstream_id: string
        }
        Update: {
          brand_id?: string | null
          created_at?: string
          credential_profile_id?: string | null
          default_sql_template_id?: string | null
          id?: string
          kpi_config?: Json
          name?: string
          reference_credential_profile_id?: string | null
          reference_url?: string | null
          schedule_cron?: string | null
          url?: string
          warehouse_connector_id?: string | null
          workstream_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "reports_brand_id_fkey"
            columns: ["brand_id"]
            isOneToOne: false
            referencedRelation: "brands"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reports_credential_profile_id_fkey"
            columns: ["credential_profile_id"]
            isOneToOne: false
            referencedRelation: "credential_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reports_default_sql_template_id_fkey"
            columns: ["default_sql_template_id"]
            isOneToOne: false
            referencedRelation: "sql_templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reports_reference_credential_profile_id_fkey"
            columns: ["reference_credential_profile_id"]
            isOneToOne: false
            referencedRelation: "credential_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reports_warehouse_connector_id_fkey"
            columns: ["warehouse_connector_id"]
            isOneToOne: false
            referencedRelation: "warehouse_connectors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reports_workstream_id_fkey"
            columns: ["workstream_id"]
            isOneToOne: false
            referencedRelation: "workstreams"
            referencedColumns: ["id"]
          },
        ]
      }
      runs: {
        Row: {
          finished_at: string | null
          id: string
          scope_id: string | null
          scope_type: string
          started_at: string | null
          status: string
          summary: Json
          trigger_source: string
        }
        Insert: {
          finished_at?: string | null
          id?: string
          scope_id?: string | null
          scope_type: string
          started_at?: string | null
          status?: string
          summary?: Json
          trigger_source?: string
        }
        Update: {
          finished_at?: string | null
          id?: string
          scope_id?: string | null
          scope_type?: string
          started_at?: string | null
          status?: string
          summary?: Json
          trigger_source?: string
        }
        Relationships: []
      }
      scenario_filter_key_map: {
        Row: {
          be_column: string
          created_at: string
          fe_label: string
          id: string
          report_id: string
          updated_at: string
        }
        Insert: {
          be_column: string
          created_at?: string
          fe_label: string
          id?: string
          report_id: string
          updated_at?: string
        }
        Update: {
          be_column?: string
          created_at?: string
          fe_label?: string
          id?: string
          report_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "scenario_filter_key_map_report_id_fkey"
            columns: ["report_id"]
            isOneToOne: false
            referencedRelation: "reports"
            referencedColumns: ["id"]
          },
        ]
      }
      scenario_filter_matrix: {
        Row: {
          created_at: string
          filters: Json
          id: string
          label: string | null
          scenario_id: string
        }
        Insert: {
          created_at?: string
          filters?: Json
          id?: string
          label?: string | null
          scenario_id: string
        }
        Update: {
          created_at?: string
          filters?: Json
          id?: string
          label?: string | null
          scenario_id?: string
        }
        Relationships: []
      }
      scenario_versions: {
        Row: {
          created_at: string
          criticality: string | null
          deferred: boolean | null
          description: string | null
          id: string
          scenario_id: string
          status: string | null
          title: string | null
          type: string | null
          version: number
        }
        Insert: {
          created_at?: string
          criticality?: string | null
          deferred?: boolean | null
          description?: string | null
          id?: string
          scenario_id: string
          status?: string | null
          title?: string | null
          type?: string | null
          version: number
        }
        Update: {
          created_at?: string
          criticality?: string | null
          deferred?: boolean | null
          description?: string | null
          id?: string
          scenario_id?: string
          status?: string | null
          title?: string | null
          type?: string | null
          version?: number
        }
        Relationships: []
      }
      scenarios: {
        Row: {
          created_at: string
          criticality: string
          deferred: boolean
          description: string | null
          id: string
          prerun_id: string | null
          reference_url: string | null
          report_id: string
          status: string | null
          title: string
          type: string | null
        }
        Insert: {
          created_at?: string
          criticality?: string
          deferred?: boolean
          description?: string | null
          id?: string
          prerun_id?: string | null
          reference_url?: string | null
          report_id: string
          status?: string | null
          title: string
          type?: string | null
        }
        Update: {
          created_at?: string
          criticality?: string
          deferred?: boolean
          description?: string | null
          id?: string
          prerun_id?: string | null
          reference_url?: string | null
          report_id?: string
          status?: string | null
          title?: string
          type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "scenarios_report_id_fkey"
            columns: ["report_id"]
            isOneToOne: false
            referencedRelation: "reports"
            referencedColumns: ["id"]
          },
        ]
      }
      schedules: {
        Row: {
          comparator: string | null
          created_at: string
          cron: string
          enabled: boolean
          id: string
          last_run_at: string | null
          next_run_at: string | null
          scope_id: string | null
          scope_type: string
          timezone: string
        }
        Insert: {
          comparator?: string | null
          created_at?: string
          cron: string
          enabled?: boolean
          id?: string
          last_run_at?: string | null
          next_run_at?: string | null
          scope_id?: string | null
          scope_type: string
          timezone?: string
        }
        Update: {
          comparator?: string | null
          created_at?: string
          cron?: string
          enabled?: boolean
          id?: string
          last_run_at?: string | null
          next_run_at?: string | null
          scope_id?: string | null
          scope_type?: string
          timezone?: string
        }
        Relationships: []
      }
      script_versions: {
        Row: {
          assertion_spec: Json
          created_at: string
          id: string
          playwright_code: string | null
          scenario_id: string
          script_id: string
          sql_template_id: string | null
          version: number
        }
        Insert: {
          assertion_spec?: Json
          created_at?: string
          id?: string
          playwright_code?: string | null
          scenario_id: string
          script_id: string
          sql_template_id?: string | null
          version: number
        }
        Update: {
          assertion_spec?: Json
          created_at?: string
          id?: string
          playwright_code?: string | null
          scenario_id?: string
          script_id?: string
          sql_template_id?: string | null
          version?: number
        }
        Relationships: []
      }
      scripts: {
        Row: {
          assertion_spec: Json
          created_at: string
          credential_profile_id: string | null
          debug_status: string | null
          id: string
          playwright_code: string | null
          reference_credential_profile_id: string | null
          scenario_id: string
          sql_filters: Json
          sql_template_id: string | null
          updated_at: string
        }
        Insert: {
          assertion_spec?: Json
          created_at?: string
          credential_profile_id?: string | null
          debug_status?: string | null
          id?: string
          playwright_code?: string | null
          reference_credential_profile_id?: string | null
          scenario_id: string
          sql_filters?: Json
          sql_template_id?: string | null
          updated_at?: string
        }
        Update: {
          assertion_spec?: Json
          created_at?: string
          credential_profile_id?: string | null
          debug_status?: string | null
          id?: string
          playwright_code?: string | null
          reference_credential_profile_id?: string | null
          scenario_id?: string
          sql_filters?: Json
          sql_template_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "scripts_credential_profile_id_fkey"
            columns: ["credential_profile_id"]
            isOneToOne: false
            referencedRelation: "credential_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scripts_reference_credential_profile_id_fkey"
            columns: ["reference_credential_profile_id"]
            isOneToOne: false
            referencedRelation: "credential_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scripts_scenario_id_fkey"
            columns: ["scenario_id"]
            isOneToOne: false
            referencedRelation: "scenarios"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scripts_sql_template_id_fkey"
            columns: ["sql_template_id"]
            isOneToOne: false
            referencedRelation: "sql_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      sql_templates: {
        Row: {
          created_at: string
          id: string
          name: string
          parameters: Json
          report_id: string | null
          scope: string
          sql_text: string
          tags: string[] | null
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          parameters?: Json
          report_id?: string | null
          scope?: string
          sql_text: string
          tags?: string[] | null
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          parameters?: Json
          report_id?: string | null
          scope?: string
          sql_text?: string
          tags?: string[] | null
        }
        Relationships: [
          {
            foreignKeyName: "sql_templates_report_id_fkey"
            columns: ["report_id"]
            isOneToOne: false
            referencedRelation: "reports"
            referencedColumns: ["id"]
          },
        ]
      }
      test_results: {
        Row: {
          actual: Json | null
          analysis: string | null
          created_at: string
          criticality: string | null
          diff: Json | null
          dom_snapshot_url: string | null
          expected: Json | null
          healing_proposal: Json | null
          healing_status: string | null
          id: string
          rank_score: number | null
          run_id: string
          scenario_id: string | null
          screenshot_url: string | null
          severity: string | null
          status: string
        }
        Insert: {
          actual?: Json | null
          analysis?: string | null
          created_at?: string
          criticality?: string | null
          diff?: Json | null
          dom_snapshot_url?: string | null
          expected?: Json | null
          healing_proposal?: Json | null
          healing_status?: string | null
          id?: string
          rank_score?: number | null
          run_id: string
          scenario_id?: string | null
          screenshot_url?: string | null
          severity?: string | null
          status: string
        }
        Update: {
          actual?: Json | null
          analysis?: string | null
          created_at?: string
          criticality?: string | null
          diff?: Json | null
          dom_snapshot_url?: string | null
          expected?: Json | null
          healing_proposal?: Json | null
          healing_status?: string | null
          id?: string
          rank_score?: number | null
          run_id?: string
          scenario_id?: string | null
          screenshot_url?: string | null
          severity?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "test_results_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "test_results_scenario_id_fkey"
            columns: ["scenario_id"]
            isOneToOne: false
            referencedRelation: "scenarios"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      warehouse_connectors: {
        Row: {
          account: string | null
          auth_method: string | null
          created_at: string
          database: string | null
          extra: Json
          host: string | null
          http_path: string | null
          id: string
          kind: string
          name: string
          password_secret_ref: string | null
          port: number | null
          role: string | null
          schema: string | null
          token_secret_ref: string | null
          username: string | null
          warehouse: string | null
        }
        Insert: {
          account?: string | null
          auth_method?: string | null
          created_at?: string
          database?: string | null
          extra?: Json
          host?: string | null
          http_path?: string | null
          id?: string
          kind: string
          name: string
          password_secret_ref?: string | null
          port?: number | null
          role?: string | null
          schema?: string | null
          token_secret_ref?: string | null
          username?: string | null
          warehouse?: string | null
        }
        Update: {
          account?: string | null
          auth_method?: string | null
          created_at?: string
          database?: string | null
          extra?: Json
          host?: string | null
          http_path?: string | null
          id?: string
          kind?: string
          name?: string
          password_secret_ref?: string | null
          port?: number | null
          role?: string | null
          schema?: string | null
          token_secret_ref?: string | null
          username?: string | null
          warehouse?: string | null
        }
        Relationships: []
      }
      warehouse_mock: {
        Row: {
          id: string
          row: Json
          table_name: string
        }
        Insert: {
          id?: string
          row: Json
          table_name: string
        }
        Update: {
          id?: string
          row?: Json
          table_name?: string
        }
        Relationships: []
      }
      workstreams: {
        Row: {
          created_at: string
          id: string
          name: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "admin" | "user"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "user"],
    },
  },
} as const
