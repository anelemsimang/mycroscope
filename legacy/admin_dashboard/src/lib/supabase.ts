import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

export const supabase = createClient(supabaseUrl, supabaseKey)

// Types for our database
export interface Organization {
  id: string
  name: string
  email: string
  contact_person: string
  phone?: string
  address?: string
  secret_key: string
  subscription_plan: 'basic' | 'professional' | 'premium' | 'enterprise'
  subscription_status: 'active' | 'suspended' | 'cancelled'
  max_employees: number
  created_at: string
  updated_at: string
}

export interface AdminKey {
  id: string
  organization_id: string
  secret_key: string
  is_active: boolean
  created_at: string
  expires_at: string
}

export interface Employee {
  id: string
  organization_id: string
  employee_id: string
  name: string
  email: string
  password_hash: string
  role: 'employee' | 'manager' | 'admin'
  department?: string
  position?: string
  hire_date?: string
  is_active: boolean
  created_at: string
  updated_at: string
} 