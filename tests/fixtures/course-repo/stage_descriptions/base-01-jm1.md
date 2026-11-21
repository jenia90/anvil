Listen on port 6379.
{{#lang_is_rust}}
Use `std::net::TcpListener`.
{{/lang_is_rust}}
{{^lang_is_rust}}
Use your language's TCP API.
{{/lang_is_rust}}
{{#reader_is_bot}}
Only for bots.
{{/reader_is_bot}}
Don't use {{language_name}}'s built-in helpers.
