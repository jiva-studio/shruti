#!/bin/bash

# Configuration variables
DB_NAME="airflow"
DB_USER="airflow"
DB_PASSWORD="airflow"
DB_HOST="localhost"
DB_PORT="5432"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Function to check if a command succeeded
check_status() {
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}Success: $1${NC}"
    else
        echo -e "${RED}Error: $1 failed${NC}"
        exit 1
    fi
}

# Check if PostgreSQL is running
echo "Checking if PostgreSQL is running..."
pg_isready -h "$DB_HOST" -p "$DB_PORT" > /dev/null 2>&1
check_status "PostgreSQL connectivity check"

# Create the database
echo "Creating database: $DB_NAME..."
psql -U postgres -h "$DB_HOST" -p "$DB_PORT" -c "CREATE DATABASE $DB_NAME;" > /dev/null 2>&1
if [ $? -ne 0 ]; then
    echo -e "${RED}Error: Database $DB_NAME might already exist or creation failed${NC}"
else
    check_status "Database $DB_NAME created"
fi

# Create the user
echo "Creating user: $DB_USER..."
psql -U postgres -h "$DB_HOST" -p "$DB_PORT" -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASSWORD';" > /dev/null 2>&1
if [ $? -ne 0 ]; then
    echo -e "${RED}Error: User $DB_USER might already exist or creation failed${NC}"
else
    check_status "User $DB_USER created"
fi

# Grant privileges to the user on the database
echo "Granting privileges to $DB_USER on $DB_NAME..."
psql -U postgres -h "$DB_HOST" -p "$DB_PORT" -c "GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;" > /dev/null 2>&1
check_status "Privileges granted to $DB_USER"

# Grant USAGE and CREATE on the public schema to the user
echo "Granting USAGE and CREATE on public schema to $DB_USER..."
psql -U postgres -h "$DB_HOST" -p "$DB_PORT" -d "$DB_NAME" -c "GRANT USAGE, CREATE ON SCHEMA public TO $DB_USER;" > /dev/null 2>&1
check_status "USAGE and CREATE granted on public schema to $DB_USER"

# Optionally, grant privileges on all tables in the public schema
echo "Granting privileges on all tables in public schema to $DB_USER..."
psql -U postgres -h "$DB_HOST" -p "$DB_PORT" -d "$DB_NAME" -c "GRANT ALL ON ALL TABLES IN SCHEMA public TO $DB_USER;" > /dev/null 2>&1
check_status "Privileges granted on all tables in public schema to $DB_USER"

# Test the connection with the new user
echo "Testing connection with $DB_USER..."
PGPASSWORD="$DB_PASSWORD" psql -U "$DB_USER" -h "$DB_HOST" -p "$DB_PORT" -d "$DB_NAME" -c "\q" > /dev/null 2>&1
check_status "Connection test with $DB_USER"

# Output connection string for Airflow
echo -e "${GREEN}Database preparation complete!${NC}"
echo "Use the following connection string in your airflow.cfg:"
echo "postgresql+psycopg2://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME"

exit 0