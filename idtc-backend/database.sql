\set ON_ERROR_STOP on

SELECT 'CREATE DATABASE idtc_backend' WHERE NOT EXISTS (
  SELECT 1 FROM pg_database WHERE datname = 'idtc_backend'
) \gexec

\connect idtc_backend

\ir schema.sql
