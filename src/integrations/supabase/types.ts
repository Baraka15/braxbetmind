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
      api_keys: {
        Row: {
          created_at: string
          id: string
          key_hash: string
          last_used_at: string | null
          name: string
          prefix: string
          rate_limit_per_min: number
          request_count: number
          revoked_at: string | null
          user_id: string
          window_start: string
        }
        Insert: {
          created_at?: string
          id?: string
          key_hash: string
          last_used_at?: string | null
          name: string
          prefix: string
          rate_limit_per_min?: number
          request_count?: number
          revoked_at?: string | null
          user_id: string
          window_start?: string
        }
        Update: {
          created_at?: string
          id?: string
          key_hash?: string
          last_used_at?: string | null
          name?: string
          prefix?: string
          rate_limit_per_min?: number
          request_count?: number
          revoked_at?: string | null
          user_id?: string
          window_start?: string
        }
        Relationships: []
      }
      bankroll_history: {
        Row: {
          balance: number
          created_at: string
          date: string
          id: string
          pnl: number
          user_id: string
        }
        Insert: {
          balance: number
          created_at?: string
          date?: string
          id?: string
          pnl?: number
          user_id: string
        }
        Update: {
          balance?: number
          created_at?: string
          date?: string
          id?: string
          pnl?: number
          user_id?: string
        }
        Relationships: []
      }
      bets: {
        Row: {
          actual_result: string | null
          ai_prob: number
          best_odds: number
          bookmaker: string
          confidence_tier: string
          consensus_prob: number | null
          created_at: string
          edge_pct: number
          id: string
          implied_prob: number
          kelly_stake_pct: number
          market: string
          match_id: string
          model_scores: Json
          outcome: string
          placed_at: string | null
          placed_odds: number | null
          placed_stake: number | null
          placement_note: string | null
          pnl_units: number
          rationale: string | null
          selection: string | null
          settled_at: string | null
          sharp_alert: boolean
          status: string
        }
        Insert: {
          actual_result?: string | null
          ai_prob: number
          best_odds: number
          bookmaker: string
          confidence_tier?: string
          consensus_prob?: number | null
          created_at?: string
          edge_pct: number
          id?: string
          implied_prob: number
          kelly_stake_pct: number
          market?: string
          match_id: string
          model_scores?: Json
          outcome: string
          placed_at?: string | null
          placed_odds?: number | null
          placed_stake?: number | null
          placement_note?: string | null
          pnl_units?: number
          rationale?: string | null
          selection?: string | null
          settled_at?: string | null
          sharp_alert?: boolean
          status?: string
        }
        Update: {
          actual_result?: string | null
          ai_prob?: number
          best_odds?: number
          bookmaker?: string
          confidence_tier?: string
          consensus_prob?: number | null
          created_at?: string
          edge_pct?: number
          id?: string
          implied_prob?: number
          kelly_stake_pct?: number
          market?: string
          match_id?: string
          model_scores?: Json
          outcome?: string
          placed_at?: string | null
          placed_odds?: number | null
          placed_stake?: number | null
          placement_note?: string | null
          pnl_units?: number
          rationale?: string | null
          selection?: string | null
          settled_at?: string | null
          sharp_alert?: boolean
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "bets_match_id_fkey"
            columns: ["match_id"]
            isOneToOne: false
            referencedRelation: "matches"
            referencedColumns: ["id"]
          },
        ]
      }
      match_results: {
        Row: {
          away_goals: number
          away_team: string
          competition: string | null
          created_at: string
          home_goals: number
          home_team: string
          id: string
          played_at: string
          source: string
          sport_key: string
        }
        Insert: {
          away_goals: number
          away_team: string
          competition?: string | null
          created_at?: string
          home_goals: number
          home_team: string
          id: string
          played_at: string
          source?: string
          sport_key: string
        }
        Update: {
          away_goals?: number
          away_team?: string
          competition?: string | null
          created_at?: string
          home_goals?: number
          home_team?: string
          id?: string
          played_at?: string
          source?: string
          sport_key?: string
        }
        Relationships: []
      }
      matches: {
        Row: {
          away: string
          commence_time: string
          home: string
          id: string
          league: string | null
          sport_key: string
          status: string
          updated_at: string
        }
        Insert: {
          away: string
          commence_time: string
          home: string
          id: string
          league?: string | null
          sport_key: string
          status?: string
          updated_at?: string
        }
        Update: {
          away?: string
          commence_time?: string
          home?: string
          id?: string
          league?: string | null
          sport_key?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      odds: {
        Row: {
          away_odds: number | null
          bookmaker: string
          draw_odds: number | null
          home_odds: number | null
          id: string
          last_update: string
          match_id: string
          opening_away: number | null
          opening_draw: number | null
          opening_home: number | null
        }
        Insert: {
          away_odds?: number | null
          bookmaker: string
          draw_odds?: number | null
          home_odds?: number | null
          id?: string
          last_update?: string
          match_id: string
          opening_away?: number | null
          opening_draw?: number | null
          opening_home?: number | null
        }
        Update: {
          away_odds?: number | null
          bookmaker?: string
          draw_odds?: number | null
          home_odds?: number | null
          id?: string
          last_update?: string
          match_id?: string
          opening_away?: number | null
          opening_draw?: number | null
          opening_home?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "odds_match_id_fkey"
            columns: ["match_id"]
            isOneToOne: false
            referencedRelation: "matches"
            referencedColumns: ["id"]
          },
        ]
      }
      predictions: {
        Row: {
          match_id: string
          p_away: number
          p_draw: number
          p_home: number
          source: string
          updated_at: string
        }
        Insert: {
          match_id: string
          p_away: number
          p_draw: number
          p_home: number
          source?: string
          updated_at?: string
        }
        Update: {
          match_id?: string
          p_away?: number
          p_draw?: number
          p_home?: number
          source?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "predictions_match_id_fkey"
            columns: ["match_id"]
            isOneToOne: true
            referencedRelation: "matches"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          email: string | null
          id: string
        }
        Insert: {
          created_at?: string
          email?: string | null
          id: string
        }
        Update: {
          created_at?: string
          email?: string | null
          id?: string
        }
        Relationships: []
      }
      team_ratings: {
        Row: {
          elo: number
          id: string
          last_match_at: string | null
          matches_played: number
          sport_key: string
          team_name: string
          updated_at: string
        }
        Insert: {
          elo?: number
          id?: string
          last_match_at?: string | null
          matches_played?: number
          sport_key: string
          team_name: string
          updated_at?: string
        }
        Update: {
          elo?: number
          id?: string
          last_match_at?: string | null
          matches_played?: number
          sport_key?: string
          team_name?: string
          updated_at?: string
        }
        Relationships: []
      }
      user_settings: {
        Row: {
          bankroll: number
          kelly_fraction: number
          last_telegram_alert_at: string | null
          max_daily_bets: number
          max_stake_pct: number
          min_edge: number
          telegram_chat_id: string | null
          telegram_min_edge: number
          tracked_leagues: string[]
          updated_at: string
          user_id: string
        }
        Insert: {
          bankroll?: number
          kelly_fraction?: number
          last_telegram_alert_at?: string | null
          max_daily_bets?: number
          max_stake_pct?: number
          min_edge?: number
          telegram_chat_id?: string | null
          telegram_min_edge?: number
          tracked_leagues?: string[]
          updated_at?: string
          user_id: string
        }
        Update: {
          bankroll?: number
          kelly_fraction?: number
          last_telegram_alert_at?: string | null
          max_daily_bets?: number
          max_stake_pct?: number
          min_edge?: number
          telegram_chat_id?: string | null
          telegram_min_edge?: number
          tracked_leagues?: string[]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      consume_api_key: {
        Args: { _hash: string; _now?: string }
        Returns: string
      }
    }
    Enums: {
      [_ in never]: never
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
    Enums: {},
  },
} as const
