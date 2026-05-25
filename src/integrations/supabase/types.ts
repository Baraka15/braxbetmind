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
          ai_prob: number
          best_odds: number
          bookmaker: string
          created_at: string
          edge_pct: number
          id: string
          implied_prob: number
          kelly_stake_pct: number
          match_id: string
          outcome: string
          sharp_alert: boolean
        }
        Insert: {
          ai_prob: number
          best_odds: number
          bookmaker: string
          created_at?: string
          edge_pct: number
          id?: string
          implied_prob: number
          kelly_stake_pct: number
          match_id: string
          outcome: string
          sharp_alert?: boolean
        }
        Update: {
          ai_prob?: number
          best_odds?: number
          bookmaker?: string
          created_at?: string
          edge_pct?: number
          id?: string
          implied_prob?: number
          kelly_stake_pct?: number
          match_id?: string
          outcome?: string
          sharp_alert?: boolean
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
      user_settings: {
        Row: {
          bankroll: number
          kelly_fraction: number
          max_daily_bets: number
          max_stake_pct: number
          min_edge: number
          tracked_leagues: string[]
          updated_at: string
          user_id: string
        }
        Insert: {
          bankroll?: number
          kelly_fraction?: number
          max_daily_bets?: number
          max_stake_pct?: number
          min_edge?: number
          tracked_leagues?: string[]
          updated_at?: string
          user_id: string
        }
        Update: {
          bankroll?: number
          kelly_fraction?: number
          max_daily_bets?: number
          max_stake_pct?: number
          min_edge?: number
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
      [_ in never]: never
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
