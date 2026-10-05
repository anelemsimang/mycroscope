from supabase import create_client, Client

def check_projects_table():
    try:
        supabase_url = "https://YOUR_PROJECT_REF.supabase.co"
        supabase_key = "REDACTED_SUPABASE_KEY"
        supabase: Client = create_client(supabase_url, supabase_key)
        
        print("🔍 Checking projects table...")
        
        # Try to select from the projects table
        try:
            result = supabase.table('projects').select('*').limit(1).execute()
            print("✅ Projects table exists and is accessible")
            print(f"📊 Found {len(result.data)} project records")
            
            if result.data:
                print("📋 Sample project data:")
                for project in result.data:
                    print(f"  - {project.get('name')}: {project.get('description', 'No description')}")
            else:
                print("📋 No projects found yet")
                
        except Exception as e:
            if "relation" in str(e).lower() and "does not exist" in str(e).lower():
                print("❌ Projects table does not exist")
                print("💡 You need to run the migration manually in Supabase dashboard")
                print("   SQL: Run the contents of create_projects_table.sql")
            else:
                print(f"❌ Error accessing projects table: {e}")
        
        return True
    except Exception as e:
        print(f"❌ Error: {e}")
        return False

if __name__ == "__main__":
    check_projects_table() 