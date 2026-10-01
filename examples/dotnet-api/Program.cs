var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapGet("/", () => Results.Json(new { service = "dotnet-api", status = "ok" }));

app.MapGet("/square/{n:int}", (int n) => Results.Json(new { input = n, result = n * n * n, op = "cube" }));

app.Run();
